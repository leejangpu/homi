// Alram🔔 봇 발신 (plain text, 마크다운 미사용). 실패해도 흐름 방해 안 함.
import https from "node:https";
import type { Env } from "./tossApi.js";

export async function notify(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("[telegram 미설정, 스킵]\n" + text);
    return;
  }
  const body = JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text });
  await new Promise<void>((resolve) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => { res.on("data", () => {}); res.on("end", () => resolve()); },
    );
    req.on("error", (e) => { console.error("telegram 실패:", e.message); resolve(); });
    req.write(body);
    req.end();
  });
}
