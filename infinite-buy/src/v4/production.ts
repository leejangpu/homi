/**
 * V4.0 프로덕션 결선 로직 (DI 방식 — KIS 의존성 주입)
 *  - runCloseV4 : 실제 보유(KIS) 동기화 → updateDaily → 상태·다음주문 영속화
 *  - runOpenV4  : 영속화된 다음주문 제출 (제출 게이트는 deps.submitOrder 구현에 위임)
 *
 * 스크립트(언이시트)와 동일하게, 체결을 추정하지 않고 KIS 실제 보유수량/평단을 입력으로 사용한다.
 */
import { updateDaily } from './unisheet.js';
import {
  readV4State, writeV4State, initV4State, appendV4Log, saveV4History, type V4State,
} from './stateV4.js';

export interface V4TickerConfig { splitCount: number; targetYield: number; largeNumPct: number; exchange: string; principal: number; }
export interface V4Config { enabled: boolean; tickers: string[]; tickerConfigs: Record<string, V4TickerConfig>; }

/** KIS 의존성 (실서버 또는 목) */
export interface BalanceHolding { ticker: string; shares: number; avgPrice: number; currentPrice: number; }
export interface V4Deps {
  getBalances(): Promise<BalanceHolding[]>;
  getCurrentPrice(ticker: string, exchange: string): Promise<number>;
  /** 주문 제출 — 실제 제출 여부(게이트)는 구현체 책임 */
  submitOrder(o: { ticker: string; side: 'BUY' | 'SELL'; orderType: 'LOC' | 'LIMIT' | 'MOC'; price: number; quantity: number; exchange: string }): Promise<void>;
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

/** ─── 장 마감: 실제 보유 → 상태 갱신 ─── */
export async function runCloseV4(cfg: V4Config, deps: V4Deps): Promise<void> {
  if (!cfg.enabled) { console.log('[V4 Close] config-v4 enabled=false → 스킵'); return; }
  const balances = await deps.getBalances();
  const date = todayStr();

  for (const ticker of cfg.tickers) {
    const tc = cfg.tickerConfigs[ticker];
    let state = readV4State(ticker) ?? initV4State({ ticker, ...tc });

    const h = balances.find(b => b.ticker === ticker);
    const newShares = h ? h.shares : 0;
    const newAvgPrice = h ? h.avgPrice : 0;
    let closePrice = h && h.currentPrice > 0 ? h.currentPrice : 0;
    if (closePrice <= 0) closePrice = await deps.getCurrentPrice(ticker, tc.exchange);
    if (closePrice <= 0) { console.error(`[V4 Close] ${ticker}: 종가 조회 실패 → 스킵`); continue; }

    const recent = state.recentCloses;
    const sma5 = recent.length >= 5 ? avg(recent.slice(-5)) : closePrice;

    const out = updateDaily({
      splitCount: state.splitCount, principal: state.principal, targetYield: state.targetYield,
      largeNumPct: state.largeNumPct, closePrice, newShares, newAvgPrice, sma5,
      oldShares: state.shares, oldAvgPrice: state.avgPrice, oldT: state.tValue,
      oldMode: state.mode, totalPrevProfit: state.cumProfit,
    });

    const newRecent = [...recent, closePrice].slice(-6);

    if (out.isCycleEnd) {
      saveV4History({
        ticker, cycleNumber: state.cycleNumber, principal: state.principal, endBalance: out.balance,
        profit: out.balance - state.principal, profitPct: (out.balance - state.principal) / state.principal * 100,
        finalT: out.finalT, startedAt: state.startedAt, completedAt: nowISO(),
      });
      // 복리: 종료 잔금이 새 사이클 원금
      const next = initV4State({ ticker, ...tc, principal: out.balance });
      next.recentCloses = newRecent;
      state = next;
    } else {
      state = {
        ...state, mode: out.mode, tValue: out.T, shares: newShares, avgPrice: newAvgPrice,
        cumProfit: state.cumProfit + out.todayProfit, recentCloses: newRecent,
        nextBuyOrders: out.buyOrders, nextSellOrders: out.sellOrders, updatedAt: nowISO(),
      };
    }
    writeV4State(state);
    appendV4Log(date, {
      ts: nowISO(), ticker, phase: 'close', mode: out.mode, close: closePrice, shares: newShares,
      avg: newAvgPrice, T: Number(out.T.toFixed(5)), P: Number(out.P.toFixed(2)), balance: Number(out.balance.toFixed(2)),
      profit: Number(out.todayProfit.toFixed(2)), isCycleEnd: out.isCycleEnd,
      nextBuy: state.nextBuyOrders, nextSell: state.nextSellOrders,
    });
    console.log(`[V4 Close] ${ticker} | ${out.mode} | 종가 ${closePrice} 보유 ${newShares}@${newAvgPrice} T ${out.T.toFixed(3)} 잔금 ${out.balance.toFixed(2)}${out.isCycleEnd ? ' ★사이클종료' : ''}`);
    console.log(`           다음 매수 ${state.nextBuyOrders.length}건 / 매도 ${state.nextSellOrders.length}건`);
  }
}

/** ─── 장 개시: 다음주문 제출 ─── */
export async function runOpenV4(cfg: V4Config, deps: V4Deps): Promise<void> {
  if (!cfg.enabled) { console.log('[V4 Open] config-v4 enabled=false → 스킵'); return; }
  const date = todayStr();
  for (const ticker of cfg.tickers) {
    const state = readV4State(ticker);
    if (!state) { console.log(`[V4 Open] ${ticker}: 상태 없음 (close 먼저 실행 필요) → 스킵`); continue; }
    const tc = cfg.tickerConfigs[ticker];
    const orders = [...state.nextBuyOrders, ...state.nextSellOrders];
    if (orders.length === 0) { console.log(`[V4 Open] ${ticker}: 제출할 주문 없음`); continue; }
    for (const o of orders) {
      await deps.submitOrder({ ticker, side: o.kind, orderType: o.type, price: o.price, quantity: o.qty, exchange: tc.exchange });
    }
    appendV4Log(date, { ts: nowISO(), ticker, phase: 'open', submitted: orders.length });
    console.log(`[V4 Open] ${ticker}: ${orders.length}건 제출 처리 완료`);
  }
}
