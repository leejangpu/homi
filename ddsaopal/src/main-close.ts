// 장 마감 후(KST 아침): 제출주문 체결 대조 → 상태/사이클 갱신 → 다음날 계획 영속.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, FillResult } from "./types.js";
import { runClose } from "./calculator.js";
import { loadState, saveState } from "./state.js";
import { notify, } from "./telegram.js";
import { getBuyingPowerUSD, getHoldingQty, getLastSessionClose, getOrder, getToken, loadEnv } from "./tossApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg: Config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf8"));

async function main() {
  const env = loadEnv();
  const token = await getToken(env);

  const { date: today, close: todayClose } = await getLastSessionClose(token, cfg.symbol);
  const state = loadState(cfg);

  if (state.lastCloseDate === today) {
    console.log(`[close] ${today} 이미 반영됨, 스킵`);
    return;
  }

  const availableCash = await getBuyingPowerUSD(token, cfg.accountSeq);

  // 제출주문 체결 대조
  const fills: FillResult[] = [];
  for (const o of state.submittedOrders) {
    const st = await getOrder(token, cfg.accountSeq, o.orderId);
    fills.push({
      clientOrderId: o.clientOrderId,
      kind: o.kind,
      lotId: o.lotId,
      filledQty: st.filledQty,
      filledPrice: st.avgFilledPrice || todayClose,
    });
  }

  const next = runClose(state, { today, todayClose, availableCash, fills }, cfg);
  next.submittedOrders = [];
  next.lastCloseDate = today;

  // 정합성 점검: 상태 로트 합계 vs 실보유
  const lotQty = next.lots.reduce((a, l) => a + l.qty, 0);
  const heldQty = await getHoldingQty(token, cfg.accountSeq, cfg.symbol);
  const mismatch = lotQty !== heldQty ? `⚠️ 수량불일치 상태 ${lotQty} vs 실보유 ${heldQty}` : "";

  saveState(next);

  const filledBuys = fills.filter((f) => f.kind === "buy" && f.filledQty > 0);
  const filledSells = fills.filter((f) => f.kind !== "buy" && f.filledQty > 0);
  const lines = [
    `[떨사오팔 ${cfg.symbol}] 마감반영 ${today}`,
    `종가 ${todayClose} / 매수가능 $${availableCash.toFixed(2)}`,
    `체결: 매수 ${filledBuys.length} · 매도/손절 ${filledSells.length}`,
    `보유 ${next.lots.length}떨 (사이클 ${next.cycleSeq}, 1분할 $${next.splitAmount.toFixed(2)})`,
    `다음 계획: ${next.plannedOrders.map((o) => `${o.kind} ${o.qty}@${o.price}`).join(", ") || "없음"}`,
  ];
  if (mismatch) lines.push(mismatch);
  const msg = lines.join("\n");
  console.log(msg);
  await notify(env, msg);
}

main().catch(async (e) => {
  console.error(e);
  try { await notify(loadEnv(), `[떨사오팔 ${cfg.symbol}] close 오류: ${e.message}`); } catch {}
  process.exit(1);
});
