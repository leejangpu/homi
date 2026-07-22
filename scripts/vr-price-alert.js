// VR 가격 알림: 장중 매시 VR 트래커 종목의 현재가를 토스 OpenAPI로 조회해
// 매수점/매도점(주문 목록의 지정가) 도달 시 Alram🔔 텔레그램으로 알린다.
// - 주문 목록은 웹 vrCalculate와 동일 공식으로 생성, buyGroupSize/sellGroupSize 묶음 기준으로 판정
// - 이미 체결 처리된 주문(executedBuy/SellCount, 원본 seq 기준)은 제외
// - 여러 점을 지나쳤으면 가장 깊은 점 가격 + 누적 수량으로 알림 (예: "₩900 매도점 돌파, 총 6주 매도")
// - KRW 종목 → 국내장(market-calendar/KR), USD 종목 → 미국장(market-calendar/US) 개장 시에만 조회
// - 조회 심볼: 트래커 `marketTicker`(웹 "조회용 티커" 필드), USD는 ticker 자체가 티커 형태면 폴백
// - 같은 종목·같은 도달 지점은 KST 하루 1회만 알림, 더 깊은 점 돌파 시 재알림 (state 파일 dedup)
// 스케줄: launchd com.homi.vr-price-alert.plist (매시 05분)

const fs = require('fs');
const path = require('path');
const https = require('https');

const ENV_PATH = path.join(__dirname, '../infinite-buy/.env');
const DB_PATH = path.join(__dirname, '../financial/data/homi.db');
const STATE_PATH = path.join(__dirname, '../logs/vr-price-alert-state.json');

const TOSS_BASE = 'openapi.tossinvest.com';
// 토스 콘솔 허용 IP가 IPv4라 반드시 IPv4로 나가야 함 (CLAUDE.md 참조)
const ipv4Agent = new https.Agent({ family: 4 });

function parseEnv(p) {
  const env = {};
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${options.path}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON 파싱 실패 ${options.path}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function tossToken(env) {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(env.TOSS_API_KEY)}&client_secret=${encodeURIComponent(env.TOSS_SECRET_KEY)}`;
  const j = await request({
    hostname: TOSS_BASE, path: '/oauth2/token', method: 'POST', agent: ipv4Agent,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  const token = j.access_token || (j.result && j.result.access_token);
  if (!token) throw new Error('토스 토큰 발급 실패: ' + JSON.stringify(j).slice(0, 200));
  return token;
}

function tossGet(token, apiPath) {
  return request({
    hostname: TOSS_BASE, path: apiPath, method: 'GET', agent: ipv4Agent,
    headers: { Authorization: `Bearer ${token}` },
  });
}

// 정규장 세션(KR은 integrated.regularMarket, US는 regularMarket) 기준으로 현재 개장 여부.
// 날짜 경계(미국장은 KST 자정 걸침) 대비 today + previousBusinessDay 둘 다 검사.
async function isMarketOpen(token, market) {
  const j = await tossGet(token, `/api/v1/market-calendar/${market}`);
  const r = j.result || {};
  const now = Date.now();
  for (const day of [r.today, r.previousBusinessDay]) {
    if (!day) continue;
    const session = market === 'KR' ? (day.integrated && day.integrated.regularMarket) : day.regularMarket;
    if (!session) continue;
    const start = Date.parse(session.startTime);
    const end = Date.parse(session.endTime);
    if (now >= start && now <= end) return true;
  }
  return false;
}

function loadTrackers() {
  const Database = require(path.join(__dirname, '../financial/node_modules/better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare('SELECT ticker, data FROM vr_tracker').all();
  db.close();
  return rows
    .map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } })
    .filter(t => t && t.cycleStatus === 'active');
}

function resolveSymbol(t) {
  if (t.marketTicker) return String(t.marketTicker).toUpperCase();
  // 조회용 티커 미입력 폴백: USD이고 종목명이 티커 형태면 그대로 사용
  if ((t.currency || 'USD') === 'USD' && /^[A-Za-z][A-Za-z.\-]*$/.test(t.ticker)) return t.ticker.toUpperCase();
  return null;
}

const round2 = n => Math.round(n * 100) / 100;

// ===== 주문 목록 생성 — 웹 vrCalculate(financial/index.html)와 동일 공식 =====

function calcWeekNumber(strategyStartDate) {
  if (!strategyStartDate) return 0;
  const start = new Date(strategyStartDate + 'T00:00:00+09:00');
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)));
}

function buildOrders(t) {
  const V = t.targetValue;
  const Q = t.totalQuantity;
  const bandRate = (t.bandPercent || 15) / 100;
  const minBand = round2(V * (1 - bandRate));
  const maxBand = round2(V * (1 + bandRate));

  const baseLimitMap = { accumulate: 0.75, lump: 0.50, withdraw: 0.25 };
  const baseLimit = baseLimitMap[t.investmentMode] || 0.75;
  const weekNumber = calcWeekNumber(t.strategyStartDate);
  const poolLimit = Math.max(0.10, baseLimit - Math.floor(weekNumber / 26) * 0.05);
  const buyBudget = (t.pool || 0) * poolLimit * 0.60;

  const buyOrders = [];
  let remaining = buyBudget;
  for (let n = 1; n <= 500 && remaining > 0; n++) {
    const price = round2(minBand / (Q + n));
    if (price <= 0 || remaining < price) break;
    remaining -= price;
    buyOrders.push({ seq: n, price });
  }

  const sellOrders = [];
  for (let n = 1; n < Q; n++) sellOrders.push({ seq: n, price: round2(maxBand / (Q - n)) });

  return { buyOrders, sellOrders, minBand, maxBand };
}

// 웹 vrApplyGrouping과 동일: groupSize개씩 묶고 묶음 지정가 = 마지막(가장 깊은) 주문의 가격
function applyGrouping(orders, groupSize) {
  if (!groupSize || groupSize <= 1) return orders.map(o => ({ ...o, firstOrigSeq: o.seq, lastOrigSeq: o.seq }));
  const grouped = [];
  for (let i = 0; i < orders.length; i += groupSize) {
    const chunk = orders.slice(i, i + groupSize);
    grouped.push({
      firstOrigSeq: chunk[0].seq,
      lastOrigSeq: chunk[chunk.length - 1].seq,
      price: chunk[chunk.length - 1].price,
    });
  }
  return grouped;
}

// 현재가가 도달한 미체결 매수/매도점을 찾는다.
// 매수점: 가격이 지정가 이하로 내려오면 도달(점 가격은 내림차순), 매도점: 지정가 이상이면 도달(오름차순).
// executed(체결 고수위, 원본 seq)는 제외하고, 도달한 점들의 누적 수량과 가장 깊은 점 가격을 돌려준다.
function findTriggered(t, price) {
  const { buyOrders, sellOrders } = buildOrders(t);
  const check = (type, orders, groupSize, executed) => {
    const groups = applyGrouping(orders, groupSize);
    const crossed = groups.filter(g =>
      g.lastOrigSeq > executed && (type === 'buy' ? price <= g.price : price >= g.price));
    if (!crossed.length) return null;
    let qty = 0;
    for (const g of crossed) qty += g.lastOrigSeq - Math.max(executed, g.firstOrigSeq - 1);
    const prices = crossed.map(g => g.price);
    return {
      type, qty,
      price: type === 'buy' ? Math.min(...prices) : Math.max(...prices),
      furthestSeq: Math.max(...crossed.map(g => g.lastOrigSeq)),
    };
  };
  return check('buy', buyOrders, t.buyGroupSize || 1, t.executedBuyCount || 0)
    || check('sell', sellOrders, t.sellGroupSize || 1, t.executedSellCount || 0);
}

function fmtMoney(n, currency) {
  if (currency === 'KRW') return '₩' + Math.round(n).toLocaleString('ko-KR');
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function kstToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) { return {}; }
}

async function sendTelegram(env, text) {
  const body = JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text });
  await request({
    hostname: 'api.telegram.org', path: `/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

async function main() {
  const env = parseEnv(ENV_PATH);
  for (const k of ['TOSS_API_KEY', 'TOSS_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!env[k]) throw new Error(`.env에 ${k} 없음`);
  }

  const trackers = loadTrackers();
  if (!trackers.length) { console.log('활성 VR 트래커 없음 — 종료'); return; }

  const byMarket = { KR: [], US: [] };
  for (const t of trackers) {
    const symbol = resolveSymbol(t);
    if (!symbol) { console.log(`[skip] ${t.ticker}: 조회용 티커 미입력 (웹 VR 계산기에서 입력 필요)`); continue; }
    byMarket[(t.currency || 'USD') === 'KRW' ? 'KR' : 'US'].push({ t, symbol });
  }
  if (!byMarket.KR.length && !byMarket.US.length) { console.log('조회 가능한 종목 없음 — 종료'); return; }

  const token = await tossToken(env);

  const targets = [];
  for (const market of ['KR', 'US']) {
    if (!byMarket[market].length) continue;
    const open = await isMarketOpen(token, market);
    console.log(`${market} 장: ${open ? '개장중' : '휴장/장외'} (종목 ${byMarket[market].map(x => x.symbol).join(',') || '-'})`);
    if (open) targets.push(...byMarket[market]);
  }
  if (!targets.length) { console.log('개장중인 시장 없음 — 종료'); return; }

  const symbols = [...new Set(targets.map(x => x.symbol))].join(',');
  const priceRes = await tossGet(token, `/api/v1/prices?symbols=${encodeURIComponent(symbols)}`);
  const priceMap = {};
  for (const p of priceRes.result || []) priceMap[p.symbol] = parseFloat(p.lastPrice);

  const state = loadState();
  const today = kstToday();
  let alerted = 0;

  for (const { t, symbol } of targets) {
    const price = priceMap[symbol];
    if (!price || !(price > 0)) { console.log(`[warn] ${t.ticker}(${symbol}): 현재가 조회 실패`); continue; }

    const cur = t.currency || 'USD';
    const hit = findTriggered(t, price);
    console.log(`${t.ticker}(${symbol}) 현재가 ${price} → ${hit ? `${hit.type} ${hit.qty}주 (점 ${hit.price}, seq≤${hit.furthestSeq})` : '도달한 점 없음'}`);
    if (!hit) continue;

    const prev = state[t.ticker];
    if (prev && prev.type === hit.type && prev.furthestSeq >= hit.furthestSeq && prev.date === today) {
      console.log('  (오늘 이미 알림 — dedup)'); continue;
    }

    const isBuy = hit.type === 'buy';
    const msg =
      `⚖️ VR ${isBuy ? '매수' : '매도'} 신호 — ${t.ticker}\n\n` +
      `${fmtMoney(hit.price, cur)} ${isBuy ? '매수' : '매도'}점 돌파 → 총 ${hit.qty}주 ${isBuy ? '매수' : '매도'}해주세요\n` +
      `현재가: ${fmtMoney(price, cur)} (${symbol})\n\n` +
      `체결 후 웹 VR 계산기에서 체크하거나, Claude에게 "체크해줘"라고 요청하세요.`;
    await sendTelegram(env, msg);
    state[t.ticker] = { type: hit.type, furthestSeq: hit.furthestSeq, date: today };
    alerted++;
    console.log('  → 텔레그램 알림 발송');
  }

  if (alerted) fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`완료: 알림 ${alerted}건`);
}

module.exports = { buildOrders, applyGrouping, findTriggered, loadTrackers };

if (require.main === module) {
  main().catch(e => { console.error('vr-price-alert 실패:', e.message); process.exit(1); });
}
