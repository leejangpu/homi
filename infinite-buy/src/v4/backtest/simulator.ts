/**
 * V4.0 백테스트 — 체결 시뮬레이터("증권사" 역할) + 사이클 러너
 *
 * 언이시트 스크립트는 체결을 시뮬하지 않고 실제 보유수량을 입력받는다.
 * 백테스트에서는 직전일 주문(pending)을 당일 OHLC에 대해 체결시켜 newShares/newAvgPrice를 만든 뒤,
 * updateDaily()(스크립트 포팅)에 넣어 T·모드·잔금·다음주문을 얻는다.
 *
 * 체결 규칙(결정론):
 *  매수 LOC : 종가 ≤ 지정가 → 종가로 체결
 *  매도 LOC : 종가 ≥ 지정가 → 종가로 체결
 *  매도 LIMIT(지정가): 당일 고가 ≥ 지정가 → 지정가로 체결
 *  매도 MOC : 종가로 무조건 체결
 *  매수는 직전 잔금(prevBalance) 한도 내에서만 체결(현금 부족분은 미체결).
 */
import { updateDaily, startCycle, type UniOrder, type Mode, type DailyInput } from '../unisheet.js';

export interface OHLC { date: string; high: number; low: number; close: number; }

export interface SimConfig {
  ticker: string;
  splitCount: number;
  principal: number;
  targetYield: number;   // 퍼센트 (예: TQQQ 15, SOXL 20)
  largeNumPct: number;   // 큰수 기준 % (기본 10)
}

export interface DayRecord {
  date: string; mode: Mode; close: number; avg: number; shares: number;
  T: number; P: number; sma5: number; invested: number; balance: number;
  amt: number; profit: number; cumProfit: number;
  buy: string; sell: string;
}

function simulateFills(
  pendingBuy: UniOrder[], pendingSell: UniOrder[],
  oldShares: number, oldAvg: number, prevBalance: number, day: OHLC
): { newShares: number; newAvgPrice: number } {
  let shares = oldShares, avg = oldAvg, cash = prevBalance;
  // 매수 (LOC, 종가 체결, 잔금 한도)
  let boughtQty = 0, boughtCost = 0;
  for (const o of pendingBuy) {
    if (o.type === 'LOC' && day.close <= o.price) {
      const affordable = Math.min(o.qty, Math.floor(cash / day.close));
      if (affordable <= 0) continue;
      boughtQty += affordable; boughtCost += affordable * day.close; cash -= affordable * day.close;
    }
  }
  if (boughtQty > 0) { avg = (avg * shares + boughtCost) / (shares + boughtQty); shares += boughtQty; }
  // 매도
  for (const o of pendingSell) {
    if (shares <= 0) break;
    let fill = false;
    if (o.type === 'MOC') fill = true;
    else if (o.type === 'LOC' && day.close >= o.price) fill = true;
    else if (o.type === 'LIMIT' && day.high >= o.price) fill = true;
    if (fill) shares -= Math.min(o.qty, shares);
  }
  if (shares <= 0) { shares = Math.max(0, shares); return { newShares: shares, newAvgPrice: shares === 0 ? 0 : avg }; }
  return { newShares: shares, newAvgPrice: avg };
}

export interface BacktestResult {
  records: DayRecord[];
  cycles: { endDate: string; startPrincipal: number; endBalance: number; profit: number; pct: number; finalT: number }[];
  finalBalance: number;
}

/** 단일 종목 백테스트. 사이클 종료 시 자동으로 다음 사이클 시작(복리: 종료잔금이 새 원금). */
export function runBacktest(cfg: SimConfig, ohlc: OHLC[]): BacktestResult {
  const records: DayRecord[] = [];
  const cycles: BacktestResult['cycles'] = [];

  let principal = cfg.principal;
  // 사이클 상태
  let oldShares = 0, oldAvg = 0, oldT = 0, oldMode: Mode = 'NORMAL';
  let cumProfit = 0;
  let prevBalance = principal;
  let pendingBuy: UniOrder[] = [];
  let pendingSell: UniOrder[] = [];

  // startCycle (day0): 주문 없음
  startCycle({ splitCount: cfg.splitCount, principal, targetYield: cfg.targetYield });

  for (let i = 0; i < ohlc.length; i++) {
    const day = ohlc[i];
    // 언이시트 D8: 최근 5거래일 종가 평균 (오늘 포함). i-4..i
    const sma5 = i >= 4
      ? (ohlc.slice(i - 4, i + 1).reduce((s, d) => s + d.close, 0) / 5)
      : day.close;

    // 1) 직전 주문 체결 → 오늘 보유
    const { newShares, newAvgPrice } = simulateFills(pendingBuy, pendingSell, oldShares, oldAvg, prevBalance, day);

    // 2) 스크립트 로직
    const inp: DailyInput = {
      splitCount: cfg.splitCount, principal, targetYield: cfg.targetYield, largeNumPct: cfg.largeNumPct,
      closePrice: day.close, newShares, newAvgPrice, sma5,
      oldShares, oldAvgPrice: oldAvg, oldT, oldMode, totalPrevProfit: cumProfit,
    };
    const out = updateDaily(inp);

    records.push({
      date: day.date, mode: out.mode, close: day.close, avg: newAvgPrice, shares: newShares,
      T: out.T, P: out.P, sma5, invested: newShares * newAvgPrice, balance: out.balance,
      amt: out.amt, profit: out.todayProfit, cumProfit: cumProfit + out.todayProfit,
      buy: out.buyOrders.map(o => `${o.type}${o.price || ''}×${o.qty}`).join(' | ') || '-',
      sell: out.sellOrders.map(o => `${o.type}${o.price || ''}×${o.qty}`).join(' | ') || '-',
    });

    cumProfit += out.todayProfit;

    if (out.isCycleEnd) {
      const endBalance = out.balance;
      cycles.push({
        endDate: day.date, startPrincipal: principal, endBalance,
        profit: endBalance - principal, pct: (endBalance - principal) / principal * 100, finalT: out.finalT,
      });
      // 복리: 새 사이클 원금 = 종료 잔금
      principal = endBalance;
      oldShares = 0; oldAvg = 0; oldT = 0; oldMode = 'NORMAL'; cumProfit = 0;
      prevBalance = principal; pendingBuy = []; pendingSell = [];
      startCycle({ splitCount: cfg.splitCount, principal, targetYield: cfg.targetYield });
      continue;
    }

    // 다음날로 상태 이월
    oldShares = newShares; oldAvg = newAvgPrice; oldT = out.T; oldMode = out.mode;
    prevBalance = out.balance;
    pendingBuy = out.buyOrders; pendingSell = out.sellOrders;
  }

  const finalBalance = records.length ? records[records.length - 1].balance : principal;
  return { records, cycles, finalBalance };
}
