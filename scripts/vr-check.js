// VR 체결 체크: VR 트래커의 executedBuy/SellCount를 갱신한다.
// - 기본(무인자/--all): 오늘 보낸 가격알림(logs/vr-price-alert-state.json)의 도달점(furthestSeq)까지
//   전부 체결한 것으로 반영. "오늘 보낸 매수/매도 전부 체결했어 체크해줘" 요청을 1커맨드로 처리.
// - <ticker>: 특정 트래커만
// - <ticker> <buy|sell> <n>: 수동으로 executed{Buy|Sell}Count = n
// - --status: 쓰기 없이 현재 executed 카운트 + 오늘 알림 상태만 출력
// 갱신은 financial/store.applyVrPatch(낙관적 잠금·버전 증가)로 하고, 끝에 gitsync.afterVrChange()로
// 파일 미러(vr-state.json) export + git 커밋까지 웹/API와 동일 경로로 반영한다.
//
// 사용 예:
//   node scripts/vr-check.js                 # 오늘 알림 전부 체결 반영
//   node scripts/vr-check.js ISA              # 부분매칭 트래커만
//   node scripts/vr-check.js ISA buy 16       # 수동 지정
//   node scripts/vr-check.js --status         # 조회만

const fs = require('fs');
const path = require('path');

const FIN = path.join(__dirname, '../financial');
const store = require(path.join(FIN, 'store'));
const gitsync = require(path.join(FIN, 'gitsync'));
const STATE_PATH = path.join(__dirname, '../logs/vr-price-alert-state.json');

const kstToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

function loadAlertState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) { return {}; }
}

// 부분/정확 매칭으로 트래커 키를 찾는다. 모호하면 후보를 던진다.
function resolveTicker(trackers, query) {
  const keys = Object.keys(trackers);
  if (keys.includes(query)) return query;
  const ci = keys.filter(k => k.toLowerCase() === query.toLowerCase());
  if (ci.length === 1) return ci[0];
  const sub = keys.filter(k => k.toLowerCase().includes(query.toLowerCase()));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) throw new Error(`"${query}" 모호함 — 후보: ${sub.join(', ')}`);
  throw new Error(`"${query}" 매칭 트래커 없음 — 존재: ${keys.join(', ')}`);
}

function printStatus(trackers, versions) {
  const alert = loadAlertState();
  const today = kstToday();
  for (const [ticker, t] of Object.entries(trackers)) {
    const a = alert[ticker];
    const todayNote = a && a.date === today
      ? `오늘 알림 ${a.type} seq≤${a.furthestSeq}`
      : '오늘 알림 없음';
    console.log(`${ticker}: buy=${t.executedBuyCount || 0} sell=${t.executedSellCount || 0} (v${versions[ticker]}) — ${todayNote}`);
  }
}

// 한 트래커의 executed 카운트를 목표값으로 올린다(내리지 않음). 변경 없으면 false.
function applyOne(ticker, trackers, versions, updates) {
  const t = trackers[ticker];
  let changed = false;
  const parts = [];
  for (const [key, target] of Object.entries(updates)) {
    const cur = t[key] || 0;
    if (target > cur) { parts.push(`${key} ${cur} → ${target}`); t[key] = target; changed = true; }
    else if (target === cur) parts.push(`${key} ${cur} (이미 반영됨)`);
  }
  if (!changed) { console.log(`${ticker}: ${parts.join(', ') || '변경 없음'}`); return false; }
  t.lastUpdated = new Date().toISOString();
  const res = store.applyVrPatch(ticker, t, versions[ticker], 'vr-check');
  if (res.conflict) throw new Error(`${ticker}: 버전 충돌(v${res.currentVersion}) — 재시도 필요`);
  console.log(`${ticker}: ${parts.join(', ')} → v${res.version}`);
  return true;
}

function main() {
  const args = process.argv.slice(2).filter(a => a !== '--all');
  const { trackers, versions } = store.getVrTrackers();

  if (args[0] === '--status') { printStatus(trackers, versions); return; }

  const targets = [];  // { ticker, updates }

  if (args.length >= 3) {
    // 수동: <ticker> <buy|sell> <n>
    const ticker = resolveTicker(trackers, args[0]);
    const type = args[1].toLowerCase();
    const n = parseInt(args[2], 10);
    if (!['buy', 'sell'].includes(type) || !Number.isFinite(n)) throw new Error('사용법: vr-check.js <ticker> <buy|sell> <n>');
    targets.push({ ticker, updates: { [type === 'buy' ? 'executedBuyCount' : 'executedSellCount']: n } });
  } else {
    // 오늘 알림 반영: (인자 없으면 전 트래커, 있으면 해당 트래커)
    const alert = loadAlertState();
    const today = kstToday();
    const only = args[0] ? resolveTicker(trackers, args[0]) : null;
    for (const [ticker, a] of Object.entries(alert)) {
      if (only && ticker !== only) continue;
      if (!trackers[ticker]) continue;
      if (a.date !== today) { if (only) console.log(`${ticker}: 오늘 보낸 알림 없음 (마지막 ${a.date})`); continue; }
      const key = a.type === 'buy' ? 'executedBuyCount' : 'executedSellCount';
      targets.push({ ticker, updates: { [key]: a.furthestSeq } });
    }
    if (only && !targets.length && !loadAlertState()[only]) console.log(`${only}: 알림 이력 없음`);
  }

  if (!targets.length) { console.log('반영할 대상 없음. 오늘 보낸 알림이 없거나 이미 반영됨. (--status 로 확인)'); return; }

  let anyChanged = false;
  for (const { ticker, updates } of targets) anyChanged = applyOne(ticker, trackers, versions, updates) || anyChanged;

  if (anyChanged) {
    gitsync.afterVrChange();  // export vr-state.json + 디바운스 git 커밋
    console.log('→ 파일 미러 export + git 커밋 예약됨');
    setTimeout(() => process.exit(0), 6000);  // 디바운스(5s) 커밋 완료 대기 후 종료
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('vr-check 실패:', e.message); process.exit(1); }
}
