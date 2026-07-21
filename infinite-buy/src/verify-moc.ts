/**
 * KIS 해외 MOC 매도 접수 가능 여부 실검증 (1주, 즉시 취소).
 *
 * 순서:
 *   ① 무해한 LOC 매도(현재가×2, 체결 불가) 1주 → 접수 확인 → 취소 → 취소 확인  [취소기능 검증]
 *   ② MOC 매도 1주 → 접수 확인 → (접수됐으면) 즉시 취소                         [MOC 검증]
 *
 * 안전장치: env VERIFY_LIVE=YES 없으면 아무 것도 안 함. 각 주문 접수 즉시 취소.
 * 실행: VERIFY_LIVE=YES npx tsx src/verify-moc.ts   (미국장 접수 시간대에만 의미)
 */
import { KisApiClient, type OrderResponse } from './kisApi.js';
import { fmtUSD } from './utils.js';

const LIVE = process.env.VERIFY_LIVE === 'YES';
const TICKER = 'SOXL';
const EXCHANGE = 'AMEX';

function dump(tag: string, r: OrderResponse) {
  console.log(`  [${tag}] rt_cd=${r.rt_cd} msg_cd=${r.msg_cd} msg1=${(r.msg1 || '').trim()}`);
  if (r.output) console.log(`         ODNO=${r.output.ODNO} KRX_FWDG=${r.output.KRX_FWDG_ORD_ORGNO} ORD_TMD=${r.output.ORD_TMD}`);
  return r.rt_cd === '0';
}

async function main() {
  const now = new Date();
  console.log('========================================');
  console.log(`[VerifyMOC] ${now.toISOString()}  (KST ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})`);
  console.log(`[VerifyMOC] ET ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  console.log(`[VerifyMOC] LIVE=${LIVE} ticker=${TICKER}/${EXCHANGE}`);
  console.log('========================================');
  if (!LIVE) {
    console.log('[VerifyMOC] VERIFY_LIVE!=YES → 아무 것도 안 함 (안전 종료).');
    return;
  }

  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const accountNo = process.env.KIS_ACCOUNT_NO!;
  if (!appKey || !appSecret || !accountNo) throw new Error('KIS creds 미설정');

  const kis = new KisApiClient();
  const token = await kis.getAccessToken(appKey, appSecret);
  const price = await kis.getCurrentPrice(appKey, appSecret, token, TICKER, EXCHANGE);
  console.log(`[VerifyMOC] 현재가 ${fmtUSD(price)}`);

  const cancel = async (label: string, r: OrderResponse, qty: number) => {
    if (r.rt_cd !== '0' || !r.output?.ODNO) { console.log(`  [${label}] 접수 실패 → 취소 스킵`); return; }
    console.log(`  [${label}] 취소 시도 (ODNO=${r.output.ODNO})...`);
    const c = await kis.cancelOrder(appKey, appSecret, token, accountNo, {
      ticker: TICKER, exchange: EXCHANGE,
      orgOrderNo: r.output.ODNO, krxFwdgOrgNo: r.output.KRX_FWDG_ORD_ORGNO, quantity: qty,
    });
    dump(`${label} 취소`, c);
  };

  // ── ① 취소 기능 검증: 무해한 LOC 매도 (현재가×2, 체결 불가) ──
  console.log('\n── ① LOC 매도(현재가×2) 접수→취소 [취소기능 검증] ──');
  const locPrice = Math.round(price * 2 * 100) / 100;
  const loc = await kis.submitOrder(appKey, appSecret, token, accountNo, {
    ticker: TICKER, side: 'SELL', orderType: 'LOC', price: locPrice, quantity: 1, exchange: EXCHANGE,
  });
  dump('LOC 제출', loc);
  await new Promise(r => setTimeout(r, 800));
  await cancel('LOC', loc, 1);

  // ── ② MOC 매도 검증 ──
  console.log('\n── ② MOC 매도 1주 접수→취소 [MOC 검증] ──');
  const moc = await kis.submitOrder(appKey, appSecret, token, accountNo, {
    ticker: TICKER, side: 'SELL', orderType: 'MOC', price: 0, quantity: 1, exchange: EXCHANGE,
  });
  const mocOk = dump('MOC 제출', moc);
  await new Promise(r => setTimeout(r, 800));
  await cancel('MOC', moc, 1);

  console.log('\n========================================');
  console.log(`[VerifyMOC] 결론: MOC 접수 ${mocOk ? '✅ 성공(KIS가 MOC 매도 받음)' : '❌ 실패 → msg1 확인'}`);
  console.log('========================================');
}

main().catch(e => { console.error('[VerifyMOC] 오류:', e); process.exit(1); });
