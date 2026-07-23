// 떨사오팔 순수 코어. I/O 없음. SPEC.md 포팅.
// 두 진입점:
//   applyFills(state, ctx, cfg)  — 마감 후 체결 반영 + 사이클 리셋 + prevClose 갱신
//   planNextDay(state, ctx, cfg) — 다음 개장일 주문 계획(매수/이익매도/손절) 산출
// main-close 는 applyFills → planNextDay 순으로 호출한다.

import type { CloseContext, Config, CycleState, FillResult, Lot, PlannedOrder } from "./types.js";

// ---------- 틱/금액 유틸 ----------

/** US 호가 단위: $1 이상 0.01, 미만 0.0001 */
export function tickFor(price: number): number {
  return price >= 1 ? 0.01 : 0.0001;
}

/** 틱에 맞춰 올림 (이익매도가: 0.3% 이상 보장) */
export function ceilTick(price: number): number {
  const t = tickFor(price);
  return Math.round(Math.ceil(price / t) * t * 1e6) / 1e6;
}

/** 틱에 맞춰 내림 (저가 종가매도가) */
export function floorTick(price: number): number {
  const t = tickFor(price);
  return Math.round(Math.floor(price / t) * t * 1e6) / 1e6;
}

/** 금액 센트 절삭 */
function floorCent(x: number): number {
  return Math.floor(x * 100) / 100;
}

// ---------- id / 멱등성 키 ----------

function lotId(cycleSeq: number, buyDate: string): string {
  return `c${cycleSeq}d${buyDate.replace(/-/g, "")}`;
}

function clientOrderId(date: string, kindCode: string, lot?: string): string {
  // ^[a-zA-Z0-9\-_]+$, <=36
  const base = `${date}-${kindCode}${lot ? "-" + lot : ""}`;
  return base.slice(0, 36);
}

// ---------- 1) 체결 반영 ----------

/**
 * 오늘 마감 체결을 상태에 반영한다.
 * - 매도/손절 체결 → 로트 제거(부분이면 수량 차감)
 * - 살아남은 기존 로트 → daysHeld += 1 (오늘 마감을 넘겼으므로)
 * - 매수 체결 → 새 로트 추가(daysHeld=0)
 * - 반영 후 flat(로트 0) 이 되면 사이클 리셋(splitAmount 재계산)
 */
export function applyFills(state: CycleState, ctx: CloseContext, cfg: Config): CycleState {
  const hadLots = state.lots.length > 0;
  const byLot = new Map<string, FillResult>();
  let buyFill: FillResult | undefined;
  for (const f of ctx.fills) {
    if (f.kind === "buy") buyFill = f;
    else if (f.lotId) byLot.set(f.lotId, f);
  }

  // 기존 로트: 매도/손절 반영 + 생존분 aging
  const survivors: Lot[] = [];
  for (const lot of state.lots) {
    const f = byLot.get(lot.id);
    let qty = lot.qty;
    if (f && f.filledQty > 0) qty -= f.filledQty; // 매도 체결분 차감
    if (qty <= 0) continue; // 전량 매도 → 로트 소멸
    survivors.push({ ...lot, qty, daysHeld: lot.daysHeld + 1 });
  }

  // 매수 체결 → 새 로트 (aging 대상 아님)
  let cycleSeq = state.cycleSeq;
  const lots = [...survivors];
  if (buyFill && buyFill.filledQty > 0) {
    const id = lotId(cycleSeq, ctx.today);
    lots.push({
      id,
      buyDate: ctx.today,
      buyPrice: buyFill.filledPrice,
      qty: buyFill.filledQty,
      daysHeld: 0,
    });
  }

  // 사이클 리셋: flat 이 되면(직전에 로트가 있었거나 splitAmount 미설정) 재분할
  let splitAmount = state.splitAmount;
  let cycleStartCash = state.cycleStartCash;
  if (lots.length === 0 && (hadLots || splitAmount <= 0)) {
    if (hadLots) cycleSeq += 1;          // 실제 사이클 종료 → 다음 사이클 번호
    else if (cycleSeq === 0) cycleSeq = 1; // 최초 부트스트랩 → 1번 사이클
    splitAmount = floorCent(ctx.availableCash / cfg.splits);
    cycleStartCash = ctx.availableCash;
  }

  return {
    ...state,
    cycleSeq,
    splits: cfg.splits,
    splitAmount,
    cycleStartCash,
    lots,
    prevClose: ctx.todayClose, // 내일 매수 기준선
    plannedOrders: [],
    updatedAt: ctx.today,
  };
}

// ---------- 2) 다음날 주문 계획 ----------

/**
 * prevClose(= 오늘 종가) 기준으로 다음 개장일 주문을 계획한다.
 * - 매수: 남은분할 있으면 min(splitAmount, cash/남은분할) 만큼 LOC 매수
 * - 각 로트: 손절 대상(daysHeld+1 >= stopLossOpenDays)이면 저가 종가매도, 아니면 이익매도
 * applyFills 뒤에 호출(= state 는 오늘 마감 반영 완료 상태).
 */
export function planNextDay(state: CycleState, ctx: CloseContext, cfg: Config): PlannedOrder[] {
  const orders: PlannedOrder[] = [];
  const prevClose = state.prevClose;
  if (prevClose == null || prevClose <= 0) return orders;

  const heldCount = state.lots.length;
  const remainingSplits = cfg.splits - heldCount;

  // --- 매수 ---
  if (remainingSplits > 0) {
    const perSplit = state.splitAmount;
    const byRemaining = ctx.availableCash / remainingSplits;
    const buyAmount = Math.min(perSplit, byRemaining);
    const qty = Math.floor(buyAmount / prevClose);
    if (qty >= 1) {
      orders.push({
        kind: "buy",
        side: "BUY",
        symbol: cfg.symbol,
        price: prevClose,
        qty,
        clientOrderId: clientOrderId(ctx.today, "b"),
      });
    }
  }

  // --- 매도 / 손절 (로트별) ---
  for (const lot of state.lots) {
    const projected = lot.daysHeld + 1; // 다음 마감 기준
    if (projected >= cfg.stopLossOpenDays) {
      // 손절: 저가 LOC 로 종가 체결 유도 (토스 MOC 미지원)
      const price = floorTick(prevClose * (1 - cfg.stopSellDiscount));
      orders.push({
        kind: "stop_sell",
        side: "SELL",
        symbol: cfg.symbol,
        price,
        qty: lot.qty,
        lotId: lot.id,
        clientOrderId: clientOrderId(ctx.today, "s", lot.id),
      });
    } else {
      // 이익매도: 매수가 +0.3% (틱 올림)
      const price = ceilTick(lot.buyPrice * (1 + cfg.sellProfitRate));
      orders.push({
        kind: "profit_sell",
        side: "SELL",
        symbol: cfg.symbol,
        price,
        qty: lot.qty,
        lotId: lot.id,
        clientOrderId: clientOrderId(ctx.today, "p", lot.id),
      });
    }
  }

  return orders;
}

/** applyFills → planNextDay 를 묶은 하루치 마감 처리 */
export function runClose(state: CycleState, ctx: CloseContext, cfg: Config): CycleState {
  const reconciled = applyFills(state, ctx, cfg);
  const plannedOrders = planNextDay(reconciled, ctx, cfg);
  return { ...reconciled, plannedOrders };
}

/** 초기(빈) 상태 */
export function initState(cfg: Config): CycleState {
  return {
    symbol: cfg.symbol,
    cycleSeq: 0,
    splits: cfg.splits,
    splitAmount: 0,
    cycleStartCash: 0,
    lots: [],
    prevClose: null,
    plannedOrders: [],
    updatedAt: "",
  };
}
