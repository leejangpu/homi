// 읽기전용 스모크 테스트: 토큰/캔들/매수가능금액/보유/캘린더 확인. 주문·저장·알림 없음.
//   npx tsx src/probe.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.js";
import { getBuyingPowerUSD, getDailyClose, getHoldingQty, getToken, getUSCalendar, loadEnv } from "./tossApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg: Config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf8"));

const token = await getToken(loadEnv());
console.log("✅ 토큰 발급 OK");
const cal = await getUSCalendar(token);
console.log("캘린더:", cal);
const c = await getDailyClose(token, cfg.symbol);
console.log(`${cfg.symbol} 일봉:`, c);
const bp = await getBuyingPowerUSD(token, cfg.accountSeq);
console.log("매수가능금액 USD:", bp);
const held = await getHoldingQty(token, cfg.accountSeq, cfg.symbol);
console.log(`${cfg.symbol} 보유수량:`, held);
console.log(`\n참고: 1분할(=매수가능/${cfg.splits}) ≈ $${(bp / cfg.splits).toFixed(2)}, 대략 ${Math.floor((bp / cfg.splits) / c.close)}주 @${c.close}`);
