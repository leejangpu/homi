/**
 * V4.0 프로덕션 결선 로직 (DI 방식 — KIS 의존성 주입)
 *  - runCloseV4 : 실제 보유(KIS) 동기화 → updateDaily → 상태·다음주문 영속화
 *  - runOpenV4  : 영속화된 다음주문 제출 (제출 게이트는 deps.submitOrder 구현에 위임)
 *
 * 핵심 정책:
 *  - 전환 가드: 종목별로 기존 v2.2/v3.0 사이클이 끝나고(보유 0, 미진행) 나서야 v4가 그 종목을 인수.
 *  - 원금 소스: 첫 v4 사이클은 실계좌 예수금(USD)을 미시작 종목 수로 균등 배분. 이후 사이클은 복리(종료 잔금).
 *  - 5일평균: KIS 실제 일봉(최근 5거래일 종가) 사용. 실패 시 누적 종가로 폴백.
 */
import { updateDaily } from './unisheet.js';
import {
  readV4State, writeV4State, initV4State, appendV4Log, saveV4History, readV2Status, type V4State,
} from './stateV4.js';

export interface V4TickerConfig { splitCount: number; targetYield: number; largeNumPct: number; exchange: string; principal: number; }
export interface V4Config {
  enabled: boolean;
  tickers: string[];
  tickerConfigs: Record<string, V4TickerConfig>;
  capitalSource?: 'account' | 'fixed'; // account=실계좌 예수금 배분(기본), fixed=tickerConfig.principal
}

export interface BalanceHolding { ticker: string; shares: number; avgPrice: number; currentPrice: number; }
export interface V4Deps {
  getBalances(): Promise<BalanceHolding[]>;
  getCurrentPrice(ticker: string, exchange: string): Promise<number>;
  getDailyCloses(ticker: string, exchange: string, count: number): Promise<number[]>; // 최근→오래된 or 시간순, 오늘 포함
  getAvailableCashUSD(): Promise<number>;                                            // 외화 주문가능금액(예수금)
  submitOrder(o: { ticker: string; side: 'BUY' | 'SELL'; orderType: 'LOC' | 'LIMIT' | 'MOC'; price: number; quantity: number; exchange: string }): Promise<void>;
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

/** ─── 장 마감: 실제 보유 → 상태 갱신 ─── */
export async function runCloseV4(cfg: V4Config, deps: V4Deps): Promise<void> {
  if (!cfg.enabled) { console.log('[V4 Close] config-v4 enabled=false → 스킵'); return; }
  const capitalSource = cfg.capitalSource ?? 'account';
  const balances = await deps.getBalances();
  const date = todayStr();

  // 아직 v4 미시작 종목(원금 배분 분모)
  const notStarted = cfg.tickers.filter(t => !readV4State(t));
  let availableCash = 0;
  if (capitalSource === 'account' && notStarted.length > 0) {
    try { availableCash = await deps.getAvailableCashUSD(); }
    catch (e) { console.error('[V4 Close] 예수금 조회 실패:', e); }
  }

  for (const ticker of cfg.tickers) {
    const tc = cfg.tickerConfigs[ticker];
    const h = balances.find(b => b.ticker === ticker);
    const kisShares = h ? h.shares : 0;
    let state = readV4State(ticker);

    // ── 전환 가드: v4 미시작 종목 ──
    if (!state) {
      const v2 = readV2Status(ticker);
      if ((v2 && v2.active) || kisShares > 0) {
        console.log(`[V4 Close] ${ticker}: 기존 전략 진행중/잔여보유(${kisShares}주) → v4 대기`);
        continue;
      }
      const principal = capitalSource === 'account'
        ? Math.floor(availableCash / Math.max(1, notStarted.length))
        : tc.principal;
      if (principal <= 0) { console.log(`[V4 Close] ${ticker}: 배분 원금 0 → 대기`); continue; }
      state = initV4State({ ticker, ...tc, principal });
      console.log(`[V4 Close] ${ticker}: ★ v4 활성화 (첫 사이클 원금 $${principal}, 소스=${capitalSource})`);
    }

    // ── 종가 ──
    let closePrice = h && h.currentPrice > 0 ? h.currentPrice : 0;
    if (closePrice <= 0) { try { closePrice = await deps.getCurrentPrice(ticker, tc.exchange); } catch { /* */ } }
    if (closePrice <= 0) { console.error(`[V4 Close] ${ticker}: 종가 조회 실패 → 스킵`); continue; }

    // ── 5일평균: 실제 일봉 우선, 폴백 누적종가 ──
    let sma5 = closePrice;
    try {
      const closes = await deps.getDailyCloses(ticker, tc.exchange, 6);
      if (closes.length >= 5) sma5 = avg(closes.slice(-5));
      else if (state.recentCloses.length >= 5) sma5 = avg(state.recentCloses.slice(-5));
    } catch { if (state.recentCloses.length >= 5) sma5 = avg(state.recentCloses.slice(-5)); }

    const newShares = kisShares;
    const newAvgPrice = h ? h.avgPrice : 0;

    const out = updateDaily({
      splitCount: state.splitCount, principal: state.principal, targetYield: state.targetYield,
      largeNumPct: state.largeNumPct, closePrice, newShares, newAvgPrice, sma5,
      oldShares: state.shares, oldAvgPrice: state.avgPrice, oldT: state.tValue,
      oldMode: state.mode, totalPrevProfit: state.cumProfit,
    });

    const newRecent = [...state.recentCloses, closePrice].slice(-6);

    if (out.isCycleEnd) {
      saveV4History({
        ticker, cycleNumber: state.cycleNumber, principal: state.principal, endBalance: out.balance,
        profit: out.balance - state.principal, profitPct: (out.balance - state.principal) / state.principal * 100,
        finalT: out.finalT, startedAt: state.startedAt, completedAt: nowISO(),
      });
      const next = initV4State({ ticker, ...tc, principal: out.balance }); // 복리
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
      avg: newAvgPrice, T: Number(out.T.toFixed(5)), P: Number(out.P.toFixed(2)), sma5: Number(sma5.toFixed(2)),
      balance: Number(out.balance.toFixed(2)), profit: Number(out.todayProfit.toFixed(2)), isCycleEnd: out.isCycleEnd,
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
    if (!state) { console.log(`[V4 Open] ${ticker}: v4 미시작 → 스킵`); continue; }
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
