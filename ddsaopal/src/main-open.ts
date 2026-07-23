// 장 개시(KST 새벽, 마감 1시간 전): 전날 계획한 LOC 주문 제출.
// 3중 가드: config.enabled + DDSAOPAL_LIVE_ORDERS=YES_REALLY + (기본 DRY-RUN)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, SubmittedOrder } from "./types.js";
import { loadState, saveState } from "./state.js";
import { notify } from "./telegram.js";
import { getToken, getUSCalendar, loadEnv, placeLocOrder } from "./tossApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg: Config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf8"));

async function main() {
  const env = loadEnv();
  const live = cfg.enabled && process.env.DDSAOPAL_LIVE_ORDERS === "YES_REALLY";
  const token = await getToken(env);

  const cal = await getUSCalendar(token);
  if (!cal.regularOpen) {
    console.log(`[open] ${cal.todayDate} 미국 정규장 휴장, 스킵`);
    return;
  }

  const state = loadState(cfg);
  const planned = state.plannedOrders;
  if (planned.length === 0) {
    console.log("[open] 계획된 주문 없음");
    await notify(env, `[떨사오팔 ${cfg.symbol}] ${cal.todayDate} 제출 주문 없음`);
    return;
  }

  const mode = live ? "LIVE" : "DRY-RUN";
  const results: string[] = [];

  if (live) {
    const submitted: SubmittedOrder[] = [];
    for (const o of planned) {
      try {
        const { orderId } = await placeLocOrder(token, cfg.accountSeq, o);
        submitted.push({ ...o, orderId, submitDate: cal.todayDate });
        results.push(`✅ ${o.kind} ${o.side} ${o.qty}@${o.price} (${orderId.slice(0, 8)})`);
      } catch (e: any) {
        results.push(`❌ ${o.kind} ${o.side} ${o.qty}@${o.price}: ${e.message}`);
      }
    }
    state.submittedOrders = submitted;
    state.plannedOrders = [];
    saveState(state);
  } else {
    for (const o of planned) results.push(`(dry) ${o.kind} ${o.side} ${o.qty}@${o.price}`);
  }

  const msg = [`[떨사오팔 ${cfg.symbol}] 개장주문 ${cal.todayDate} [${mode}]`, ...results].join("\n");
  console.log(msg);
  await notify(env, msg);
}

main().catch(async (e) => {
  console.error(e);
  try { await notify(loadEnv(), `[떨사오팔 ${cfg.symbol}] open 오류: ${e.message}`); } catch {}
  process.exit(1);
});
