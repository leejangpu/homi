/**
 * V4.0 장 마감 엔트리포인트 — 실제 보유 동기화 + 상태/다음주문 영속화 (주문 제출 없음).
 * 실행: npx tsx src/v4/main-close-v4.ts
 * 기존 main-close.ts(v2.2/v3.0)와 완전 독립.
 */
import { loadV4Config, loadCreds, isLive, buildRealDeps } from './kisDeps.js';
import { runCloseV4 } from './production.js';

(async () => {
  console.log(`===== V4.0 CLOSE (${new Date().toISOString()}) | LIVE주문=${isLive()} =====`);
  const cfg = loadV4Config();
  if (!cfg.enabled) { console.log('config-v4 enabled=false → 종료'); return; }
  const creds = loadCreds();
  if (!creds.appKey || !creds.appSecret || !creds.accountNo) { console.error('KIS 자격증명 미설정 → 종료'); process.exit(1); }
  const deps = await buildRealDeps(cfg, creds);
  await runCloseV4(cfg, deps);
  console.log('===== V4.0 CLOSE 완료 =====');
})().catch(e => { console.error('[V4 Close] 오류:', e); process.exit(1); });
