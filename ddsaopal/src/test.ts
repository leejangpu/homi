// 떨사오팔 코어 시나리오 검증 (결정론적, I/O 없음).
//   npx tsx src/test.ts   또는   npm test
// 실제 LOC 체결 규칙을 흉내내는 시뮬레이터로 여러 날을 돌려 상태를 검증한다.

import { ceilTick, floorTick, initState, planNextDay, runClose } from "./calculator.js";
import type { CloseContext, Config, CycleState, FillResult, PlannedOrder } from "./types.js";

const cfg: Config = {
  enabled: false,
  symbol: "TEST",
  splits: 7,
  sellProfitRate: 0.003,
  stopLossOpenDays: 12,
  stopSellDiscount: 0.3,
  capitalSource: "toss_buyable",
  accountSeq: 1,
};

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("  ❌ " + msg); }
}
function approx(a: number, b: number, eps = 1e-6) { return Math.abs(a - b) < eps; }
function day(i: number) { return `2026-08-${String(i + 1).padStart(2, "0")}`; }

// LOC 체결 시뮬: 전날 계획(plannedOrders)이 오늘 종가에 체결되는지 판정
function simulateFills(orders: PlannedOrder[], close: number): FillResult[] {
  const fills: FillResult[] = [];
  for (const o of orders) {
    let filled = false;
    if (o.side === "BUY") filled = close <= o.price;      // LOC 매수: 종가 <= 지정가
    else filled = close >= o.price;                        // LOC 매도: 종가 >= 지정가
    fills.push({
      clientOrderId: o.clientOrderId,
      kind: o.kind,
      lotId: o.lotId,
      filledQty: filled ? o.qty : 0,
      filledPrice: filled ? close : 0,
    });
  }
  return fills;
}

// 하루 진행: 전날 상태의 계획을 오늘 종가에 체결 → 현금 갱신 → runClose
function step(state: CycleState, cash: number, i: number, close: number): { state: CycleState; cash: number } {
  const fills = simulateFills(state.plannedOrders, close);
  for (const f of fills) {
    if (f.filledQty <= 0) continue;
    const cost = f.filledQty * f.filledPrice;
    cash += f.kind === "buy" ? -cost : cost;
  }
  const ctx: CloseContext = { today: day(i), todayClose: close, availableCash: cash, fills };
  return { state: runClose(state, ctx, cfg), cash };
}

// ===== 시나리오 A: 매수 추격 → 급등 전량 이익매도 → 사이클 리셋 =====
{
  console.log("시나리오 A: 매수체인 + 이익매도 + 사이클 리셋");
  let s = initState(cfg);
  let cash = 700;

  ({ state: s, cash } = step(s, cash, 0, 100)); // day0: 부트스트랩
  ok(approx(s.splitAmount, 100), `A: splitAmount=100 (got ${s.splitAmount})`);
  ok(s.prevClose === 100, "A: prevClose=100");
  ok(s.plannedOrders.length === 1 && s.plannedOrders[0].kind === "buy" && s.plannedOrders[0].qty === 1,
     "A: day0 매수 1주 계획");

  ({ state: s, cash } = step(s, cash, 1, 99));  // 하락 → 1떨 체결
  ok(s.lots.length === 1 && approx(s.lots[0].buyPrice, 99), "A: 1떨 @99 체결");
  const psell = s.plannedOrders.find(o => o.kind === "profit_sell");
  ok(!!psell && approx(psell!.price, ceilTick(99 * 1.003)), `A: 이익매도가 = ceilTick(99*1.003)=${ceilTick(99*1.003)}`);
  ok(s.plannedOrders.some(o => o.kind === "buy" && approx(o.price, 99)), "A: 다음 매수 @99(prevClose) 계획");

  ({ state: s, cash } = step(s, cash, 2, 98));  // 또 하락 → 2떨
  ok(s.lots.length === 2, "A: 2떨 보유");
  ok(s.lots[0].daysHeld === 1 && s.lots[1].daysHeld === 0, "A: aging (1,0)");

  ({ state: s, cash } = step(s, cash, 3, 100)); // 급등 → 두 떨 모두 매도가 초과 → 전량 매도
  ok(s.lots.length === 0, "A: 전량 매도 → flat");
  ok(s.cycleSeq === 2, `A: 사이클 종료 → seq 2 (got ${s.cycleSeq})`);
  ok(approx(s.splitAmount, Math.floor((cash) * 100 / 7) / 100), `A: 재분할 splitAmount=cash/7 (got ${s.splitAmount}, cash ${cash})`);
  ok(s.plannedOrders.filter(o => o.kind === "buy").length === 1, "A: 새 사이클 매수 1건 계획");
  console.log(`  → 현금 ${cash.toFixed(2)}, splitAmount ${s.splitAmount}`);
}

// ===== 시나리오 B: 12영업일 손절 (저가 종가매도) =====
{
  console.log("시나리오 B: 12영업일 손절");
  let s = initState(cfg);
  let cash = 700;
  ({ state: s, cash } = step(s, cash, 0, 100)); // 부트스트랩
  ({ state: s, cash } = step(s, cash, 1, 99));  // day1: 1떨 @99, daysHeld=0
  ok(s.lots.length === 1, "B: 1떨 매수");

  // day2~ : 살짝 상승(<99.30, 매도 미체결) & 직전종가 초과(신규매수 미체결) → 로트 aging만
  let stopSeenOnPlanDay = -1;
  for (let i = 2; i <= 13; i++) {
    const close = 99.05 + (i - 2) * 0.01; // 99.05 .. 99.16, 모두 <99.30
    ({ state: s, cash } = step(s, cash, i, close));
    if (s.lots.length === 1) {
      const stop = s.plannedOrders.find(o => o.kind === "stop_sell");
      if (stop && stopSeenOnPlanDay < 0) {
        stopSeenOnPlanDay = i;
        ok(approx(stop.price, floorTick(close * 0.7)), `B: 손절가 = floorTick(prevClose*0.7)=${floorTick(close * 0.7)}`);
        ok(!s.plannedOrders.some(o => o.kind === "profit_sell"), "B: 손절일엔 이익매도 미계획");
      }
    }
  }
  // 매수 체결일 day1(=B). 손절 실행은 B+12=day13. 계획은 그 전날 day12 마감에 잡힘.
  ok(stopSeenOnPlanDay === 12, `B: 손절 계획은 day12 마감에 잡힘 (got ${stopSeenOnPlanDay})`);
  ok(s.lots.length === 0, "B: day13 손절 체결 → flat");
  ok(s.cycleSeq === 2, `B: 손절로 사이클 종료 (seq ${s.cycleSeq})`);
}

// ===== 시나리오 C: 현금 부족 시 min 매수 (남은예수금/남은분할) =====
{
  console.log("시나리오 C: 현금부족 min 매수");
  // 로트 5개 보유(남은분할=2), 매수가능금액 50, prevClose=20 → byRemaining=25 < splitAmount100
  const s: CycleState = {
    symbol: "TEST", cycleSeq: 1, splits: 7, splitAmount: 100, cycleStartCash: 700,
    lots: Array.from({ length: 5 }, (_, k) => ({ id: `L${k}`, buyDate: day(1), buyPrice: 20, qty: 1, daysHeld: 3 })),
    prevClose: 20, plannedOrders: [], updatedAt: day(1),
  };
  const ctx: CloseContext = { today: day(2), todayClose: 20, availableCash: 50, fills: [] };
  const orders = planNextDay(s, ctx, cfg);
  const buy = orders.find(o => o.kind === "buy");
  // buyAmount = min(100, 50/2=25) = 25 → qty = floor(25/20) = 1
  ok(!!buy && buy!.qty === 1, `C: min매수 qty=1 (byRemaining 25/20) (got ${buy?.qty})`);
  ok(orders.filter(o => o.kind === "profit_sell").length === 5, "C: 보유 5떨 이익매도 계획");
}

// ===== 시나리오 D: 7떨 만재 시 매수 미계획 =====
{
  console.log("시나리오 D: 만재(7떨) 매수 억제");
  const s: CycleState = {
    symbol: "TEST", cycleSeq: 1, splits: 7, splitAmount: 100, cycleStartCash: 700,
    lots: Array.from({ length: 7 }, (_, k) => ({ id: `L${k}`, buyDate: day(1), buyPrice: 90, qty: 1, daysHeld: 2 })),
    prevClose: 90, plannedOrders: [], updatedAt: day(1),
  };
  const orders = planNextDay(s, { today: day(2), todayClose: 90, availableCash: 500, fills: [] }, cfg);
  ok(!orders.some(o => o.kind === "buy"), "D: 남은분할0 → 매수 없음");
  ok(orders.filter(o => o.kind === "profit_sell").length === 7, "D: 7떨 이익매도");
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
