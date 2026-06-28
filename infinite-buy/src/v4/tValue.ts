/**
 * V4.0 T값 갱신 — [확정] (V4-SPEC §3)
 *
 * 일반모드:
 *   전량체결 → T+1 · 절반체결 → T+0.5 · 쿼터매도(익절) → T×0.75
 * 리버스모드 (문서2 p5):
 *   20분할: 매도 T×0.9  · 매수 T+(20−T)×0.25
 *   40분할: 매도 T×0.95 · 매수 T+(40−T)×0.25
 *
 * ⚠️ 분류는 KIS 실제 체결내역으로만 판정 (fillClassifier). 여기는 순수 변환식.
 * T는 소수점 무제한 (반올림 금지).
 */

// ── 일반모드 ──
export function tNormalFullBuy(t: number): number { return t + 1; }
export function tNormalHalfBuy(t: number): number { return t + 0.5; }
export function tNormalQuarterSell(t: number): number { return t * 0.75; }

// ── 리버스모드 ──
/**
 * 리버스 매도 시 T 감쇠.
 * 문서 명시값: 20분할 ×0.9, 40분할 ×0.95.
 * 패턴 1−2/split 으로 일반화되나(20→0.9, 40→0.95), 30분할은 문서 미명시 → [확인필요].
 */
export function tReverseSell(t: number, splitCount: number): number {
  if (splitCount === 20) return t * 0.9;   // [확정]
  if (splitCount === 40) return t * 0.95;  // [확정]
  // [확인필요] 30분할 등: 패턴(1−2/split) 잠정. 문서 확정 전 사용 주의.
  return t * (1 - 2 / splitCount);
}

/** 리버스 매수 시 T = 직전T + (분할수−직전T)×0.25 */
export function tReverseBuy(t: number, splitCount: number): number {
  return t + (splitCount - t) * 0.25;
}
