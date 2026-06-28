/**
 * V4.0 코어 공식 앵커 테스트
 * 라오어 문서의 "워크드 예시"를 기대값으로 고정 → 구현이 문서와 정확히 일치하는지 검증.
 * 실행: npx tsx src/v4/test-anchors.ts
 */
import { starPercent, starPointPrice, buyPointPrice } from './starPoint.js';
import { buyPerRound, shouldEnterReverse } from './buyAmount.js';
import {
  tNormalFullBuy, tNormalHalfBuy, tNormalQuarterSell,
  tReverseSell, tReverseBuy,
} from './tValue.js';

let pass = 0, fail = 0;
function eq(name: string, actual: number | boolean, expected: number | boolean, tol = 0) {
  const ok = typeof actual === 'number' && typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  if (ok) { pass++; console.log(`  ✅ ${name}: ${actual}`); }
  else { fail++; console.log(`  ❌ ${name}: got ${actual}, expected ${expected}`); }
}

console.log('§1 별지점 — 문서 p3-4: 20분할 SOXL, 평단 38.30, T=8.6 → 별% 2.8% → 별지점 39.37');
eq('starPercent', starPercent(8.6, 'SOXL', 20), 2.8, 1e-9);
eq('starPointPrice', starPointPrice(38.30, 2.8), 39.37, 0);
eq('buyPointPrice(39.37)', buyPointPrice(39.37), 39.36, 0);

console.log('\n§1 별% 4종 공식 — 문서 p3 (T=1 대입 확인)');
eq('20분할 TQQQ (15−1.5T)', starPercent(1, 'TQQQ', 20), 13.5, 1e-9);
eq('40분할 TQQQ (15−0.75T)', starPercent(1, 'TQQQ', 40), 14.25, 1e-9);
eq('20분할 SOXL (20−2T)', starPercent(1, 'SOXL', 20), 18, 1e-9);
eq('40분할 SOXL (20−T)', starPercent(1, 'SOXL', 40), 19, 1e-9);

console.log('\n§2 1회매수금 — 문서 p5: 원금 20000, 40분할, 478 체결 후 잔금 19522, T=1 → 19522/39');
eq('1일차 1금', buyPerRound(20000, 40, 0), 500, 1e-9);
eq('2일차 1금', buyPerRound(19522, 40, 1), 500.5641025641026, 1e-9);
eq('리버스 진입 T=39(40분할) → false', shouldEnterReverse(39, 40), false);
eq('리버스 진입 T=39.5(40분할) → true', shouldEnterReverse(39.5, 40), true);

console.log('\n§3 일반 T값 — 문서 p2: T=7 → 전량8 / 절반7.5 / 쿼터매도 5.25');
eq('전량체결', tNormalFullBuy(7), 8, 0);
eq('절반체결', tNormalHalfBuy(7), 7.5, 0);
eq('쿼터매도', tNormalQuarterSell(7), 5.25, 1e-9);

console.log('\n§3 리버스 T값 — 문서2 p5: 40분할 T=39.5 → 매도 37.525 → 쿼터매수 38.14375');
eq('리버스 첫날매도(40분할)', tReverseSell(39.5, 40), 37.525, 1e-9);
eq('리버스 쿼터매수(40분할)', tReverseBuy(37.525, 40), 38.14375, 1e-9);
eq('리버스 매도(20분할) T×0.9', tReverseSell(10, 20), 9, 1e-9);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
