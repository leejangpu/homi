/**
 * 무한매수법 V4.0 — 타입 정의 (기존 v2.2/v3.0과 완전 분리)
 * 사양: infinite-buy/V4-SPEC.md
 */

export type V4Mode = 'NORMAL' | 'REVERSE';
export type V4Ticker = 'TQQQ' | 'SOXL';
export type V4OrderType = 'LOC' | 'LIMIT' | 'MOC';
export type V4Side = 'BUY' | 'SELL';

export interface V4Order {
  side: V4Side;
  orderType: V4OrderType;
  price: number;        // MOC는 0
  quantity: number;
  label: string;
}

/**
 * 당일 체결 분류 (KIS 실제 체결내역에서 산출 — 추측 금지)
 * - fullBuy: 1회매수금 전량 체결
 * - halfBuy: 1회매수금 절반(가량) 체결
 * - quarterSell: 쿼터매도(별지점 LOC 매도) 체결 발생
 */
export interface V4FillResult {
  buyFilledAmount: number;   // 당일 매수 체결 금액
  buyFilledQty: number;
  sellFilledQty: number;
  quarterSellFilled: boolean; // 별지점 매도 체결 여부
  intendedBuyPerRound: number; // 당일 의도한 1회매수금
}

/** V4 전용 사이클 상태 (state/{ticker}.json 에 v4 사이클일 때만 기록) */
export interface V4CycleState {
  version: 'v4.0';
  ticker: V4Ticker;
  mode: V4Mode;
  splitCount: 20 | 30 | 40;
  principal: number;       // 사이클 원금
  remainingCash: number;   // 잔금 = 원금 − 누적매수금 (KIS 잔고 기반 동기화)
  tValue: number;          // 경로의존 누적값 (KIS 체결로만 갱신)
  totalQuantity: number;   // KIS 잔고
  avgPrice: number;        // KIS 잔고 평단
  // 리버스 전용
  reverseStartQty?: number;     // 리버스 진입 시 보유수량 (등분 기준)
  lastFiveCloses?: number[];    // 직전 5거래일 종가 (리버스 별지점용)
  startedAt: string;
  updatedAt: string;
}
