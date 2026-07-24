// VR 가격 알림: 장중 매시 VR 트래커 종목의 현재가를 토스 OpenAPI로 조회해
// 매수점/매도점(주문 목록의 지정가) 도달 시 Alram🔔 텔레그램으로 알린다.
// - 주문 목록은 웹 vrCalculate와 동일 공식으로 생성, buyGroupSize/sellGroupSize 묶음 기준으로 판정
// - 카운팅 기준선 = max(체결 executedBuy/SellCount, 오늘 이미 알린 furthestSeq) → 그 너머 신규 지점만 센다
// - 여러 점을 지나쳤으면 가장 깊은 점 가격 + 신규 누적 수량으로 알림 (예: "₩900 매도점 돌파, 총 6주 매도")
//   같은 날 앞 메시지와 수량이 겹치지 않으므로 각 메시지를 그대로 주문하면 됨(상태 갱신 레이스에도 안전)
// - KRW 종목 → 국내장(market-calendar/KR), USD 종목 → 미국장(market-calendar/US) 개장 시에만 조회
// - 조회 심볼: 트래커 `marketTicker`(웹 "조회용 티커" 필드), USD는 ticker 자체가 티커 형태면 폴백
// - state 파일(furthestSeq/session/date)로 신규 지점 판정: 같은 거래세션에 이미 알린 깊이는 재알림 안 함,
//   더 깊어지면 신규분만. 세션이 바뀌면(다음 장) floor 리셋 → 체결(executed) 안 된 지점은 미체결로 재알림
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
// 현재 정규장 세션의 식별자(`{market}:{세션시작epoch}`)를 반환. 휴장/장외면 null.
// 세션 시작 epoch를 키로 쓰므로 미국장이 KST 자정을 걸쳐도(22:30~05:00) 한 세션 = 한 키.
// → 알림 dedup을 KST 날짜가 아니라 "거래 세션" 단위로 하기 위함(자정 넘어 같은 세션 중복알림 방지 +
//   다음 세션엔 미체결분 재알림). today + previousBusinessDay 둘 다 검사(미국장 날짜경계 대비).
async function currentSession(token, market) {
  const j = await tossGet(token, `/api/v1/market-calendar/${market}`);
  const r = j.result || {};
  const now = Date.now();
  for (const day of [r.today, r.previousBusinessDay]) {
    if (!day) continue;
    const session = market === 'KR' ? (day.integrated && day.integrated.regularMarket) : day.regularMarket;
    if (!session) continue;
    const start = Date.parse(session.startTime);
    const end = Date.parse(session.endTime);
    if (now >= start && now <= end) return `${market}:${start}`;
  }
  return null;
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

// 현재가가 도달한 미체결·미알림 매수/매도점을 찾는다.
// 매수점: 가격이 지정가 이하로 내려오면 도달(점 가격은 내림차순), 매도점: 지정가 이상이면 도달(오름차순).
// 카운팅 기준선(baseline) = max(executed 체결 고수위, floor 오늘 이미 알린 seq).
// → 이미 체결했거나 오늘 이전 메시지에서 이미 알린 지점은 제외하고, 신규 지점의 누적 수량만 센다.
//   메시지 수량이 겹치지 않으므로 사용자는 각 메시지를 그대로 주문하면 되고, 상태 갱신 레이스에도 안전.
// floor = { buy, sell } (오늘 마지막 알림의 furthestSeq, 없으면 0).
function findTriggered(t, price, floor = { buy: 0, sell: 0 }) {
  const { buyOrders, sellOrders } = buildOrders(t);
  const check = (type, orders, groupSize, executed) => {
    const baseline = Math.max(executed, floor[type] || 0);
    const groups = applyGrouping(orders, groupSize);
    const crossed = groups.filter(g =>
      g.lastOrigSeq > baseline && (type === 'buy' ? price <= g.price : price >= g.price));
    if (!crossed.length) return null;
    let qty = 0;
    for (const g of crossed) qty += g.lastOrigSeq - Math.max(baseline, g.firstOrigSeq - 1);
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
    const session = await currentSession(token, market);
    console.log(`${market} 장: ${session ? '개장중' : '휴장/장외'} (종목 ${byMarket[market].map(x => x.symbol).join(',') || '-'})`);
    if (session) targets.push(...byMarket[market].map(x => ({ ...x, session })));
  }
  if (!targets.length) { console.log('개장중인 시장 없음 — 종료'); return; }

  const symbols = [...new Set(targets.map(x => x.symbol))].join(',');
  const priceRes = await tossGet(token, `/api/v1/prices?symbols=${encodeURIComponent(symbols)}`);
  const priceMap = {};
  for (const p of priceRes.result || []) priceMap[p.symbol] = parseFloat(p.lastPrice);

  const state = loadState();
  const today = kstToday();
  let alerted = 0;

  for (const { t, symbol, session } of targets) {
    const price = priceMap[symbol];
    if (!price || !(price > 0)) { console.log(`[warn] ${t.ticker}(${symbol}): 현재가 조회 실패`); continue; }

    const cur = t.currency || 'USD';
    // 같은 세션에서 이미 알린 지점은 카운팅에서 제외(floor). 여러 지점 지나쳐도 신규분만 알린다.
    // 세션이 바뀌면(다음 장) floor=0 → 체결(executed) 안 됐으면 미체결분을 다시 알린다.
    const prev = state[t.ticker];
    const floor = { buy: 0, sell: 0 };
    if (prev && prev.session === session) floor[prev.type] = prev.furthestSeq;

    const hit = findTriggered(t, price, floor);
    console.log(`${t.ticker}(${symbol}) 현재가 ${price} → ${hit ? `${hit.type} ${hit.qty}주 (점 ${hit.price}, seq≤${hit.furthestSeq}, floor ${hit.type}=${floor[hit.type]})` : '신규 도달점 없음'}`);
    if (!hit) continue;

    const isBuy = hit.type === 'buy';
    const msg =
      `⚖️ VR ${isBuy ? '매수' : '매도'} 신호 — ${t.ticker}\n\n` +
      `${fmtMoney(hit.price, cur)} ${isBuy ? '매수' : '매도'}점 돌파 → 총 ${hit.qty}주 ${isBuy ? '매수' : '매도'}해주세요\n` +
      `현재가: ${fmtMoney(price, cur)} (${symbol})\n\n` +
      `체결 후 웹 VR 계산기에서 체크하거나, Claude에게 "체크해줘"라고 요청하세요.`;
    await sendTelegram(env, msg);
    state[t.ticker] = { type: hit.type, furthestSeq: hit.furthestSeq, session, date: today };
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
