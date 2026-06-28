/**
 * V4.0 장 개시 엔트리포인트 — close가 계산해둔 다음주문 제출.
 * 실행: npx tsx src/v4/main-open-v4.ts
 * ⚠️ 환경변수 V4_LIVE_ORDERS=YES_REALLY 가 없으면 모든 주문은 DRY-RUN(로그만).
 * 기존 main-open.ts(v2.2/v3.0)와 완전 독립.
 */
import { loadV4Config, loadCreds, isLive, buildRealDeps } from './kisDeps.js';
import { runOpenV4 } from './production.js';

(async () => {
  console.log(`===== V4.0 OPEN (${new Date().toISOString()}) =====`);
  if (isLive()) console.log('🔴🔴🔴 LIVE 모드: 실제 주문이 제출됩니다 🔴🔴🔴');
  else console.log('🟡 DRY-RUN 모드: 주문은 로그만 (실제 제출 없음). 실주문하려면 V4_LIVE_ORDERS=YES_REALLY');
  const cfg = loadV4Config();
  if (!cfg.enabled) { console.log('config-v4 enabled=false → 종료'); return; }
  const creds = loadCreds();
  if (!creds.appKey || !creds.appSecret || !creds.accountNo) { console.error('KIS 자격증명 미설정 → 종료'); process.exit(1); }
  const deps = await buildRealDeps(cfg, creds);
  await runOpenV4(cfg, deps);
  console.log('===== V4.0 OPEN 완료 =====');
})().catch(e => { console.error('[V4 Open] 오류:', e); process.exit(1); });
