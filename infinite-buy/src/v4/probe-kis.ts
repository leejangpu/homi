/**
 * V4 KIS 읽기 전용 프로브 — 장 마감/평일 무관 실행 가능.
 * 실제 주문/상태쓰기 없음. 토큰·잔고·현재가·일봉(5일평균)·예수금 조회만 해서 스키마/값 확인.
 * 실행: (set -a && source .env && set +a) ; npx tsx src/v4/probe-kis.ts
 */
import { loadV4Config, loadCreds, buildRealDeps } from './kisDeps.js';

(async () => {
  console.log(`===== V4 KIS 프로브 (읽기 전용, ${new Date().toISOString()}) =====`);
  const cfg = loadV4Config();
  const creds = loadCreds();
  if (!creds.appKey || !creds.appSecret || !creds.accountNo) { console.error('KIS 자격증명 미설정'); process.exit(1); }

  const deps = await buildRealDeps(cfg, creds);
  console.log('✅ 토큰 발급 OK\n');

  const balances = await deps.getBalances();
  console.log('잔고(getBalance):');
  if (balances.length === 0) console.log('  (보유 없음)');
  for (const b of balances) console.log(`  ${b.ticker}: ${b.shares}주 @ $${b.avgPrice}, 현재가 $${b.currentPrice}`);

  try {
    const cash = await deps.getAvailableCashUSD();
    console.log(`\n예수금/주문가능(getBuyableAmount frcr_ord_psbl_amt1): $${cash}`);
  } catch (e) { console.error('\n예수금 조회 실패:', e); }

  for (const t of cfg.tickers) {
    const ex = cfg.tickerConfigs[t].exchange;
    console.log(`\n── ${t} (${ex}) ──`);
    try {
      const px = await deps.getCurrentPrice(t, ex);
      console.log(`  현재가(price): $${px}`);
    } catch (e) { console.error('  현재가 실패:', e); }
    try {
      const closes = await deps.getDailyCloses(t, ex, 6);
      const last5 = closes.slice(-5);
      const sma5 = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : 0;
      console.log(`  최근 일봉 종가(dailyprice output2.clos): ${JSON.stringify(closes)}`);
      console.log(`  → 5일평균(리버스 별지점): $${sma5.toFixed(4)}`);
    } catch (e) { console.error('  일봉 조회 실패:', e); }
  }
  console.log('\n===== 프로브 완료 (주문/상태쓰기 0) =====');
})().catch(e => { console.error('프로브 오류:', e); process.exit(1); });
