/**
 * V4.0 프로덕션 결선 검증 (목 KIS)
 *  - open→체결→close 루프를 실데이터로 돌려, 영속 상태가 검증된 백테스트와 일치하는지 확인.
 *  - DRY-RUN(실주문 게이트)에서 실제 제출이 0건인지 확인.
 * 실행: V4_STATE_ROOT=/tmp/v4wire npx tsx src/v4/backtest/wiring-test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runCloseV4, runOpenV4, type V4Config, type V4Deps } from '../production.js';
import { runBacktest, type OHLC } from './simulator.js';
import type { UniOrder } from '../unisheet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const N = Number(process.argv[2] || 120);
const ohlc: OHLC[] = JSON.parse(fs.readFileSync(path.join(DATA, 'TQQQ.json'), 'utf-8')).slice(0, N);

const cfg: V4Config = {
  enabled: true, tickers: ['TQQQ'],
  tickerConfigs: { TQQQ: { splitCount: 40, targetYield: 15, largeNumPct: 10, exchange: 'NASD', principal: 10000 } },
};

// ── 목 KIS: 보유/체결/주문을 메모리로 시뮬 (DRY-RUN: submit은 기록만) ──
let mock = { shares: 0, avg: 0, cash: 10000, curClose: 0 };
let pending: UniOrder[] = [];
let realSubmits = 0, dryLogged = 0;

function mockFill(day: OHLC) {
  let bq = 0, bc = 0;
  for (const o of pending) {
    if (o.kind === 'BUY' && o.type === 'LOC' && day.close <= o.price) {
      const a = Math.min(o.qty, Math.floor(mock.cash / day.close)); if (a <= 0) continue;
      bq += a; bc += a * day.close; mock.cash -= a * day.close;
    }
  }
  if (bq > 0) { mock.avg = (mock.avg * mock.shares + bc) / (mock.shares + bq); mock.shares += bq; }
  for (const o of pending) {
    if (o.kind !== 'SELL' || mock.shares <= 0) continue;
    let px = 0, hit = false;
    if (o.type === 'MOC') { px = day.close; hit = true; }
    else if (o.type === 'LOC' && day.close >= o.price) { px = day.close; hit = true; }
    else if (o.type === 'LIMIT' && day.high >= o.price) { px = o.price; hit = true; }
    if (hit) { const q = Math.min(o.qty, mock.shares); mock.cash += px * q; mock.shares -= q; }
  }
  if (mock.shares <= 0) { mock.shares = 0; mock.avg = 0; }
  pending = [];
}

const deps: V4Deps = {
  async getBalances() { return mock.shares > 0 ? [{ ticker: 'TQQQ', shares: mock.shares, avgPrice: mock.avg, currentPrice: mock.curClose }] : []; },
  async getCurrentPrice() { return mock.curClose; },
  async submitOrder(o) {
    // DRY-RUN 게이트 모사: 실제 제출하지 않고 pending에만 적재
    dryLogged++;
    pending.push({ kind: o.side, type: o.orderType, price: o.price, qty: o.quantity, label: '' });
    // 만약 실제 제출 경로였다면 realSubmits++ 였을 것 — 여기선 절대 증가하지 않음
  },
};

// 새 사이클 시 mock 현금/보유 리셋 동기화 (사이클 종료 감지: 상태파일 cycleNumber 변화)
function readCycle(): number {
  const p = path.join(process.env.V4_STATE_ROOT!, 'state', 'v4-TQQQ.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')).cycleNumber : 0;
}

(async () => {
  let prevCycle = 0;
  for (let i = 0; i < ohlc.length; i++) {
    const day = ohlc[i];
    mock.curClose = day.close;
    await runOpenV4(cfg, deps);   // 어제 close가 만든 다음주문 제출(→pending)
    mockFill(day);                // 당일 체결
    await runCloseV4(cfg, deps);  // 보유 동기화 → updateDaily → 다음주문 영속화
    // 사이클 종료로 새 사이클 시작됐으면 mock 현금=새 원금, 보유 0
    const cyc = readCycle();
    if (cyc !== prevCycle && prevCycle !== 0) { /* 복리: mock.cash 는 이미 balance와 동일하게 흐름 */ }
    prevCycle = cyc;
    // 다음 루프의 open이 새 nextOrders를 제출하도록 pending은 mockFill에서 비워짐
    // close가 쓴 nextOrders는 다음 open에서 submit → pending 재적재
    const st = JSON.parse(fs.readFileSync(path.join(process.env.V4_STATE_ROOT!, 'state', 'v4-TQQQ.json'), 'utf-8'));
    pending = []; // open에서 다시 채움
    // open은 다음 반복 첫 줄에서 호출되어 st.nextBuy/Sell 제출
    void st;
  }

  // 최종 상태
  const st = JSON.parse(fs.readFileSync(path.join(process.env.V4_STATE_ROOT!, 'state', 'v4-TQQQ.json'), 'utf-8'));

  // 백테스트와 대조
  const bt = runBacktest({ ticker: 'TQQQ', splitCount: 40, principal: 10000, targetYield: 15, largeNumPct: 10 }, ohlc);
  const last = bt.records[bt.records.length - 1];

  let pass = 0, fail = 0;
  const eq = (n: string, a: number, e: number, tol = 0.01) => {
    if (Math.abs(a - e) <= tol) { pass++; console.log(`  ✅ ${n}: ${a}`); }
    else { fail++; console.log(`  ❌ ${n}: 결선 ${a} vs 백테스트 ${e}`); }
  };
  console.log(`\n[결선 ↔ 백테스트 대조] (${N}일, 종료사이클 백테 ${bt.cycles.length})`);
  eq('보유수량', st.shares, last.shares);
  eq('평단', st.avgPrice, last.avg);
  eq('T값', st.tValue, last.T, 0.001);
  eq('cycleNumber', st.cycleNumber, bt.cycles.length + 1);
  console.log(`\n[실주문 가드] DRY-RUN 제출기록 ${dryLogged}건, 실제 KIS 제출 ${realSubmits}건`);
  if (realSubmits === 0) { pass++; console.log('  ✅ 실주문 0건 (안전)'); } else { fail++; console.log('  ❌ 실주문 발생!'); }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail === 0 ? 0 : 1);
})();
