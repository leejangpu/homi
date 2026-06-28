/**
 * v2.2 / v3.0 / v4.0 동일기간 백테스트 비교
 * - v4.0: src/v4/unisheet.ts (언이시트 포팅)
 * - v2.2 / v3.0: 기존 src/calculator.ts 구동 (동일 체결 시뮬)
 * 실행: npx tsx src/v4/backtest/compare.ts <dataFile>
 *
 * 공정 비교: 동일 원금·40분할, 사이클 종료 시 복리(종료 잔금이 새 원금),
 * 기말 평가액 = 잔금 + 보유수량×마지막종가.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, type OHLC } from './simulator.js';
import { calculate, calculateDecreaseRate, type StrategyVersion, type QuarterModeState } from '../../calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const DATAFILE = process.argv[2] || 'TQQQ';
const TICKER = DATAFILE.startsWith('SOXL') ? 'SOXL' : 'TQQQ';
const ohlc: OHLC[] = JSON.parse(fs.readFileSync(path.join(DATA, `${DATAFILE}.json`), 'utf-8'));
const PRINCIPAL = 10000, SPLIT = 40;

interface Order { orderType: string; price: number; quantity: number; }
function fill(buys: Order[], sells: Order[], qty: number, avg: number, cash: number, day: OHLC) {
  let bq = 0, bc = 0;
  for (const o of buys) if (o.orderType === 'LOC' && day.close <= o.price) {
    const a = Math.min(o.quantity, Math.floor(cash / day.close)); if (a <= 0) continue;
    bq += a; bc += a * day.close; cash -= a * day.close;
  }
  if (bq > 0) { avg = (avg * qty + bc) / (qty + bq); qty += bq; }
  let realized = 0;
  for (const o of sells) {
    if (qty <= 0) break;
    let px = 0, hit = false;
    if (o.orderType === 'MOC') { px = day.close; hit = true; }
    else if (o.orderType === 'LOC' && day.close >= o.price) { px = day.close; hit = true; }
    else if (o.orderType === 'LIMIT' && day.high >= o.price) { px = o.price; hit = true; }
    if (hit) { const q = Math.min(o.quantity, qty); realized += (px - avg) * q; cash += px * q; qty -= q; }
  }
  return { qty, avg: qty > 0 ? avg : 0, cash, realized };
}

function runV23(version: StrategyVersion, targetProfit: number) {
  let principal = PRINCIPAL, qty = 0, avg = 0, cash = principal;
  let buyPerRound = principal / SPLIT;
  let quarterMode: QuarterModeState | undefined;
  let pendingBuy: Order[] = [], pendingSell: Order[] = [];
  const decRate = calculateDecreaseRate(targetProfit, SPLIT);
  let cycles = 0; let lastClose = 0;

  for (const day of ohlc) {
    lastClose = day.close;
    const f = fill(pendingBuy, pendingSell, qty, avg, cash, day);
    qty = f.qty; avg = f.avg; cash = f.cash;

    if (qty <= 0 && (pendingBuy.length || pendingSell.length)) {
      // 사이클 종료 → 복리 재시작
      cycles++; principal = cash; buyPerRound = principal / SPLIT;
      quarterMode = undefined; pendingBuy = []; pendingSell = [];
      continue;
    }
    const r = calculate({
      ticker: TICKER, currentPrice: day.close, totalQuantity: qty, avgPrice: avg,
      totalInvested: qty * avg, remainingCash: cash, buyPerRound, splitCount: SPLIT,
      targetProfit, starDecreaseRate: decRate, strategyVersion: version, quarterMode,
    });
    pendingBuy = r.buyOrders as Order[];
    pendingSell = r.sellOrders as Order[];
    // v2.2 쿼터모드 상태 이월
    if (version === 'v2.2') {
      const qm = r.quarterModeInfo?.quarterModeState;
      if (qm) quarterMode = qm;
      // MOC 매도 발생 시 활성화 (다음 호출부터 쿼터 진행)
      if (quarterMode && !quarterMode.isActive && pendingSell.some(s => s.orderType === 'MOC')) {
        quarterMode = { ...quarterMode, isActive: true };
      }
    }
  }
  const totalValue = cash + qty * lastClose;
  return { version, cycles, finalCash: cash, openQty: qty, totalValue };
}

// ── v4.0 ──
const v4 = runBacktest({ ticker: TICKER, splitCount: SPLIT, principal: PRINCIPAL, targetYield: TICKER === 'SOXL' ? 20 : 15, largeNumPct: 10 }, ohlc);
const v4last = v4.records[v4.records.length - 1];
const v4total = v4last.balance + v4last.shares * v4last.close;

const v3 = runV23('v3.0', TICKER === 'SOXL' ? 0.20 : 0.15);
const v2 = runV23('v2.2', TICKER === 'SOXL' ? 0.12 : 0.10);

console.log(`\n===== ${DATAFILE} 비교 (원금 $${PRINCIPAL}, 40분할, ${ohlc[0].date}~${ohlc[ohlc.length - 1].date}, ${ohlc.length}일) =====`);
const pct = (v: number) => ((v - PRINCIPAL) / PRINCIPAL * 100).toFixed(2) + '%';
console.log(`버전   | 완료사이클 | 기말 잔금  | 보유수량 | 기말 평가액(잔금+보유) | 총수익률`);
console.log(`v2.2   | ${String(v2.cycles).padStart(8)} | ${v2.finalCash.toFixed(0).padStart(9)} | ${String(v2.openQty).padStart(7)} | ${v2.totalValue.toFixed(2).padStart(20)} | ${pct(v2.totalValue)}`);
console.log(`v3.0   | ${String(v3.cycles).padStart(8)} | ${v3.finalCash.toFixed(0).padStart(9)} | ${String(v3.openQty).padStart(7)} | ${v3.totalValue.toFixed(2).padStart(20)} | ${pct(v3.totalValue)}`);
console.log(`v4.0   | ${String(v4.cycles.length).padStart(8)} | ${v4last.balance.toFixed(0).padStart(9)} | ${String(v4last.shares).padStart(7)} | ${v4total.toFixed(2).padStart(20)} | ${pct(v4total)}`);
