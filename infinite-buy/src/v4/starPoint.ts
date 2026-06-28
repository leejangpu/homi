/**
 * V4.0 별%(별지점) 계산 — [확정] (V4-SPEC §1)
 *
 * 별%(percent) = target − T × (target × 2 / 분할수)
 *   target: TQQQ=15, SOXL=20
 * 별지점가 = 평단 × (1 + 별%/100)   (소수 2자리 반올림)
 * 매수점   = 별지점 − 0.01
 * 매도점   = 별지점 (그대로)
 */
import type { V4Ticker } from './types.js';

export function targetPercentFor(ticker: V4Ticker): number {
  return ticker === 'SOXL' ? 20 : 15;
}

/** 감소율 = target × 2 / 분할수 */
export function decreaseRate(targetPercent: number, splitCount: number): number {
  return (targetPercent * 2) / splitCount;
}

/** 별%(퍼센트 단위, 음수 가능) */
export function starPercent(tValue: number, ticker: V4Ticker, splitCount: number): number {
  const target = targetPercentFor(ticker);
  return target - tValue * decreaseRate(target, splitCount);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 별지점가 = 평단 × (1 + 별%/100), 소수 2자리 반올림 */
export function starPointPrice(avgPrice: number, starPctPercent: number): number {
  return round2(avgPrice * (1 + starPctPercent / 100));
}

/** 매수점 = 별지점 − 0.01 */
export function buyPointPrice(starPoint: number): number {
  return round2(starPoint - 0.01);
}
