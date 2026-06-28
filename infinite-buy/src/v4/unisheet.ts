/**
 * V4.0 핵심 로직 — 언이시트 Apps Script (2026/06/11 by 언이) 1:1 포팅
 * 원본: docs/unisheet-v4-source.gs.txt (updateDaily / startCycle)
 *
 * ⚠️ 추측 금지 원칙: 이 파일은 언이시트 스크립트를 변형 없이 그대로 옮긴 것이다.
 *    값/수량/가격/T·모드 전이 규칙은 모두 스크립트 그대로. 임의 개선 없음.
 *
 * 스크립트는 "체결 시뮬"을 하지 않는다 — 실제 보유수량(newShares)/평단(newAvgPrice)을
 * 입력으로 받아 직전 기록과의 차이로 action(BUY/SELL/NONE)을 추론한다.
 * 백테스트에서는 simulateFills()가 "증권사" 역할로 newShares/newAvgPrice를 만든 뒤 이 로직에 넣는다.
 */

export type Mode = 'NORMAL' | 'REVERSE' | 'CYCLE_END';
export interface UniOrder {
  kind: 'BUY' | 'SELL';
  type: 'LOC' | 'LIMIT' | 'MOC';
  price: number;   // MOC는 0
  qty: number;
  label: string;
}

/** 스크립트 toFixed(2) 와 동일한 가격 라운딩 (제출/표시 가격) */
function fx2(x: number): number { return Number(x.toFixed(2)); }

export interface DailyInput {
  // 설정
  splitCount: number;       // n
  principal: number;
  targetYield: number;      // 예: 15 (퍼센트)
  largeNumPct: number;      // 큰수 기준 %, 기본 10
  // 오늘의 실제 보유(증권사) + 종가 + 5일평균
  closePrice: number;
  newShares: number;
  newAvgPrice: number;
  sma5: number;
  // 직전 DB 기록
  oldShares: number;
  oldAvgPrice: number;
  oldT: number;
  oldMode: Mode;
  totalPrevProfit: number;  // 과거 누적 실현손익(오늘 제외)
}

export interface DailyOutput {
  mode: Mode;
  T: number;
  P: number;            // ⭐% (퍼센트)
  balance: number;
  amt: number;
  largeNum: number;
  todayProfit: number;
  isCycleEnd: boolean;
  finalT: number;
  buyOrders: UniOrder[];
  sellOrders: UniOrder[];
}

/** updateDaily() 포팅 — 직전기록 + 오늘 보유/종가 → T·모드·잔금·다음 주문 */
export function updateDaily(inp: DailyInput): DailyOutput {
  const { splitCount: n, principal, targetYield, largeNumPct,
          closePrice, newShares, newAvgPrice, sma5,
          oldShares, oldAvgPrice, oldT, totalPrevProfit } = inp;

  const previousMode = inp.oldMode;
  let mode: Mode = previousMode;
  let T = oldT;
  const action = newShares < oldShares ? 'SELL' : newShares > oldShares ? 'BUY' : 'NONE';
  let todayProfit = 0;

  if (action === 'SELL') {
    const soldQty = oldShares - newShares;
    const qQty = Math.floor(oldShares * 0.25);
    const limitSoldQty = oldShares - qQty;
    if (newShares <= 0) {
      // [상황1] 100% 매도 (사이클 종료)
      const limitPrice = oldAvgPrice * (1 + targetYield / 100);
      todayProfit = qQty * (closePrice - oldAvgPrice) + limitSoldQty * (limitPrice - oldAvgPrice);
    } else if (newShares <= oldShares * 0.60) {
      // [상황2] 3/4 지정가 매도 + 1/4 잔여 + LOC 매수 진행
      const limitPrice = oldAvgPrice * (1 + targetYield / 100);
      todayProfit = limitSoldQty * (limitPrice - oldAvgPrice);
      if (newShares > qQty) {
        if (closePrice > oldAvgPrice) T = oldT * 0.25 + 0.5;
        else T = oldT * 0.25 + 1.0;
      } else {
        T = oldT * 0.25;
      }
    } else {
      // [상황3] 일반 1/4 쿼터 LOC 매도
      todayProfit = soldQty * (closePrice - oldAvgPrice);
      T = (mode === 'NORMAL') ? oldT * 0.75 : oldT * (1 - 2 / n);
    }
  } else if (action === 'BUY') {
    if (mode === 'NORMAL') {
      if (oldShares === 0) T = T + 1.0;
      else if (T < n / 2) { T = closePrice > oldAvgPrice ? T + 0.5 : T + 1.0; }
      else T = T + 1.0;
    } else if (mode === 'REVERSE') {
      T = T + (n - T) * 0.25;
    }
  }

  let balance = principal - (newShares * newAvgPrice) + totalPrevProfit + todayProfit;
  const startP = targetYield;

  const isCycleEnd = (newShares <= 0 && action === 'SELL');
  const finalT = oldT;
  if (isCycleEnd) { mode = 'CYCLE_END'; T = 0; }
  else {
    if (mode === 'NORMAL' && T > n - 1) mode = 'REVERSE';
    else if (mode === 'REVERSE' && closePrice > newAvgPrice * (1 - targetYield / 100)) mode = 'NORMAL';
  }

  const P = (mode === 'NORMAL') ? (startP - (startP / (n / 2)) * T) : 0;

  const buyOrders: UniOrder[] = [];
  const sellOrders: UniOrder[] = [];
  const largeNum = closePrice * (1 + largeNumPct / 100);
  let amt = 0;

  if (!isCycleEnd) {
    const remT = Math.max(0.1, n - T);
    amt = (mode === 'REVERSE') ? (balance / 4) : (balance / remT);
    let baseQty = 0;
    const targetPPrice = Math.max(0.01, newAvgPrice * (1 + P / 100));       // 매도용(원본)
    const targetPBuyPrice = Math.max(0.01, targetPPrice - 0.01);           // 매수용(-0.01)
    const sma5BuyPrice = Math.max(0.01, sma5 - 0.01);                      // 리버스 매수용

    // ── 매수 ──
    if (mode === 'REVERSE' && previousMode === 'NORMAL') {
      // 🚫 매수 금지 (리버스 진입 1일차)
    } else {
      if (newShares <= 0) {
        amt = principal / n;
        baseQty = Math.floor(amt / largeNum);
        if (baseQty > 0) buyOrders.push({ kind: 'BUY', type: 'LOC', price: fx2(largeNum), qty: baseQty, label: '최초(큰수)' });
      } else if (mode === 'REVERSE') {
        baseQty = Math.floor(amt / sma5BuyPrice);
        if (baseQty > 0) buyOrders.push({ kind: 'BUY', type: 'LOC', price: fx2(sma5BuyPrice), qty: baseQty, label: '리버스매수(5일평균)' });
      } else if (T < n / 2) {
        // 전반전
        const price1 = Math.min(targetPBuyPrice, largeNum);
        const price2 = Math.min(newAvgPrice, largeNum);
        const q1 = Math.floor((amt * 0.5) / price1);
        const totalQty = Math.floor(amt / price2);
        const q2 = Math.max(0, totalQty - q1);
        baseQty = q1 + q2;
        if (q1 > 0) buyOrders.push({ kind: 'BUY', type: 'LOC', price: fx2(price1), qty: q1, label: '전반 평단🔼' });
        if (q2 > 0) buyOrders.push({ kind: 'BUY', type: 'LOC', price: fx2(price2), qty: q2, label: '전반 평단🔽' });
      } else {
        // 후반전
        const finalPrice = Math.min(targetPBuyPrice, largeNum);
        baseQty = Math.floor(amt / finalPrice);
        if (baseQty > 0) buyOrders.push({ kind: 'BUY', type: 'LOC', price: fx2(finalPrice), qty: baseQty, label: '후반(별/큰수)' });
      }

      // ── 대폭락 매수 티어 (최대 5단, amt/m < 큰수) ──
      let checkQty = baseQty + 1, tierFound = 0;
      for (let i = 0; i < 15; i++) {
        const tierPrice = amt / checkQty;
        if (tierPrice > 0 && tierPrice < largeNum) {
          buyOrders.push({ kind: 'BUY', type: 'LOC', price: fx2(tierPrice), qty: 1, label: `추가티어` });
          tierFound++;
        }
        if (tierFound >= 5) break;
        checkQty++;
      }
    }

    // ── 매도 ──
    const qQty = Math.floor(newShares * 0.25);
    const revSellQty = Math.floor(newShares / (n / 2));
    if (mode === 'REVERSE') {
      if (previousMode === 'NORMAL') sellOrders.push({ kind: 'SELL', type: 'MOC', price: 0, qty: revSellQty, label: '리버스1일차 MOC' });
      else sellOrders.push({ kind: 'SELL', type: 'LOC', price: fx2(sma5), qty: revSellQty, label: '리버스매도(5일평균)' });
    } else {
      sellOrders.push({ kind: 'SELL', type: 'LOC', price: fx2(targetPPrice), qty: qQty, label: '쿼터' });
      sellOrders.push({ kind: 'SELL', type: 'LIMIT', price: fx2(newAvgPrice * (1 + targetYield / 100)), qty: newShares - qQty, label: '지정가' });
    }
  }

  return { mode, T, P, balance, amt, largeNum, todayProfit, isCycleEnd, finalT, buyOrders, sellOrders };
}

/** startCycle() 포팅 — 사이클 시작/중간진입 초기화 */
export function startCycle(cfg: {
  splitCount: number; principal: number; targetYield: number;
  initialShares?: number; initialAvgPrice?: number;
}): { mode: Mode; T: number; P: number; balance: number; amt: number } {
  const { splitCount: n, principal, targetYield } = cfg;
  const initialShares = cfg.initialShares || 0;
  const initialAvgPrice = cfg.initialAvgPrice || 0;
  const startP = targetYield;
  let mode: Mode = 'NORMAL', T = 0, P = 0, investedAmount = 0, amt = 0, balance = principal;

  if (initialShares > 0 && initialAvgPrice > 0) {
    investedAmount = initialShares * initialAvgPrice;
    balance = principal - investedAmount;
    T = (investedAmount / principal) * n;
    P = startP - (startP / (n / 2)) * T;
    if (T > n - 1) mode = 'REVERSE';
    amt = (mode === 'REVERSE') ? (balance / 4) : (balance / Math.max(0.1, n - T));
  } else {
    P = startP; balance = principal; amt = principal / n;
  }
  return { mode, T, P, balance, amt };
}
