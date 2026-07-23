// 실주문 접수 검증(안전): 체결 불가 저가 LOC 매수 1주 접수 → 즉시 취소.
// "토스가 LIMIT+CLS(US LOC) 주문을 받아주는가"만 확인. 포지션/손실 없음.
//   npx tsx src/verify-order.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, PlannedOrder } from "./types.js";
import { floorTick } from "./calculator.js";
import { cancelOrder, getDailyClose, getOrder, getToken, getUSCalendar, loadEnv, placeLocOrder } from "./tossApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg: Config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf8"));

const token = await getToken(loadEnv());
const cal = await getUSCalendar(token);
console.log("US 정규장 오늘 운영:", cal.regularOpen, "/", cal.todayDate);

const { close } = await getDailyClose(token, cfg.symbol);
const testPrice = floorTick(close * 0.9); // 시장가 대비 10% 낮음 → 종가 체결 불가, 밴드 내
const order: PlannedOrder = {
  kind: "buy", side: "BUY", symbol: cfg.symbol, price: testPrice, qty: 1,
  clientOrderId: `verify-${cal.todayDate}-${Date.now().toString().slice(-6)}`,
};
console.log(`접수 시도: BUY 1 ${cfg.symbol} @${testPrice} (LOC=LIMIT+CLS)`);

try {
  const { orderId } = await placeLocOrder(token, cfg.accountSeq, order);
  console.log("✅ 접수 성공, orderId:", orderId);
  const st = await getOrder(token, cfg.accountSeq, orderId);
  console.log("   주문상태:", st.status, "체결수량:", st.filledQty);
  const c = await cancelOrder(token, cfg.accountSeq, orderId);
  console.log("🧹 취소 요청 완료:", JSON.stringify(c?.result ?? c).slice(0, 200));
  console.log("\n결론: 토스가 US LOC(LIMIT+CLS) 주문을 접수함. 매도/손절 저가 LOC는 실보유 후 검증.");
} catch (e: any) {
  console.error("❌ 접수 실패:", e.message);
  console.error("\n→ 실패 사유가 orderType/CLS 관련이면 전략 실행 불가. SPEC §10 재검토 필요.");
  process.exit(1);
}
