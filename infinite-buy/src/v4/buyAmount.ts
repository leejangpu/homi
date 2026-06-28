/**
 * V4.0 1회매수금 — [확정] (V4-SPEC §2)
 *
 * 1회매수금 = 잔금 / (분할수 − T)
 * 분모(분할수−T) ≤ 0 ⇒ 리버스모드 진입 신호 (여기선 계산만, 전환은 engine에서).
 */

export function buyPerRound(remainingCash: number, splitCount: number, tValue: number): number {
  const denom = splitCount - tValue;
  if (denom <= 0) return 0; // 1회분 미만 → 리버스 전환 대상
  return remainingCash / denom;
}

/** 리버스 진입조건: T > 분할수 − 1 (1회분 미만 잔금) */
export function shouldEnterReverse(tValue: number, splitCount: number): boolean {
  return tValue > splitCount - 1;
}
