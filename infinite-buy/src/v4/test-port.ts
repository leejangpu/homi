/**
 * 언이시트 Apps Script 포팅 정확성 검증 (updateDaily)
 * 기대값은 스크립트 공식을 직접 손계산. 실행: npx tsx src/v4/test-port.ts
 */
import { updateDaily, type DailyInput, type Mode } from './unisheet.js';

let pass = 0, fail = 0;
function eq(name: string, a: unknown, e: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) { pass++; console.log(`  ✅ ${name} = ${JSON.stringify(a)}`); }
  else { fail++; console.log(`  ❌ ${name} = ${JSON.stringify(a)} (기대 ${JSON.stringify(e)})`); }
}
const base = { splitCount: 40, principal: 10000, targetYield: 15, largeNumPct: 10, sma5: 40, totalPrevProfit: 0 };

console.log('① 새 사이클 (close 37.50, 보유0): 큰수 41.25×6 + 5티어, amt 250, P 15');
let o = updateDaily({ ...base, closePrice: 37.50, newShares: 0, newAvgPrice: 0, oldShares: 0, oldAvgPrice: 0, oldT: 0, oldMode: 'NORMAL' } as DailyInput);
eq('T', o.T, 0); eq('P', o.P, 15); eq('amt', o.amt, 250); eq('balance', o.balance, 10000); eq('mode', o.mode, 'NORMAL');
eq('buy.prices', o.buyOrders.map(x => x.price), [41.25, 35.71, 31.25, 27.78, 25, 22.73]);
eq('buy.qtys', o.buyOrders.map(x => x.qty), [6, 1, 1, 1, 1, 1]);

console.log('\n② 전반전 매수 전량(종가≤평단): T 1→2 (close 36 ≤ avg 37)');
o = updateDaily({ ...base, closePrice: 36, newShares: 9, newAvgPrice: 37, oldShares: 6, oldAvgPrice: 37, oldT: 1, oldMode: 'NORMAL' } as DailyInput);
eq('T', o.T, 2);

console.log('\n③ 전반전 매수 절반(종가>평단): T 1→1.5 (close 38 > avg 37)');
o = updateDaily({ ...base, closePrice: 38, newShares: 9, newAvgPrice: 37, oldShares: 6, oldAvgPrice: 37, oldT: 1, oldMode: 'NORMAL' } as DailyInput);
eq('T', o.T, 1.5);

console.log('\n④ 후반전 매수: T 25→26 (T≥n/2 단일가)');
o = updateDaily({ ...base, closePrice: 30, newShares: 60, newAvgPrice: 35, oldShares: 55, oldAvgPrice: 35, oldT: 25, oldMode: 'NORMAL' } as DailyInput);
eq('T', o.T, 26);

console.log('\n⑤ 쿼터매도(일반, 종가↑): T 8→6 (oldT×0.75), 모드 NORMAL 유지');
o = updateDaily({ ...base, closePrice: 45, newShares: 8, newAvgPrice: 40, oldShares: 10, oldAvgPrice: 40, oldT: 8, oldMode: 'NORMAL' } as DailyInput);
eq('T', o.T, 6); eq('profit', Number(o.todayProfit.toFixed(2)), Number((2 * (45 - 40)).toFixed(2)));

console.log('\n⑥ 리버스 진입: 후반전 매수로 T 39.2→40.2(>39) → REVERSE, P=0');
o = updateDaily({ ...base, closePrice: 30, newShares: 39, newAvgPrice: 35, oldShares: 38, oldAvgPrice: 35, oldT: 39.2, oldMode: 'NORMAL' } as DailyInput);
eq('T', Number(o.T.toFixed(2)), 40.2); eq('mode', o.mode, 'REVERSE'); eq('P', o.P, 0);

console.log('\n⑦ 100% 매도 → 사이클 종료(CYCLE_END), T=0');
o = updateDaily({ ...base, closePrice: 50, newShares: 0, newAvgPrice: 0, oldShares: 8, oldAvgPrice: 40, oldT: 5, oldMode: 'NORMAL' } as DailyInput);
eq('mode', o.mode, 'CYCLE_END'); eq('isCycleEnd', o.isCycleEnd, true); eq('T', o.T, 0);

console.log('\n⑧ 리버스 매도 T감쇠: 40분할 oldT×(1-2/40)=×0.95, 10→9.5');
o = updateDaily({ ...base, closePrice: 30, newShares: 8, newAvgPrice: 40, oldShares: 10, oldAvgPrice: 40, oldT: 10, oldMode: 'REVERSE' } as DailyInput);
eq('T', o.T, 9.5);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
