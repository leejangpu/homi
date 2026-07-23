// 토스증권 OpenAPI 클라이언트. IPv4 강제 필수(콘솔 등록 IP가 IPv4).
// 참고: docs/toss-api/, scripts/vr-price-alert.js
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlannedOrder } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOSS_HOST = "openapi.tossinvest.com";
const ipv4Agent = new https.Agent({ family: 4 }); // ⚠️ IPv4 강제

// ---------- env 로드: ddsaopal/.env 우선, 없으면 ../infinite-buy/.env ----------
export interface Env {
  TOSS_API_KEY: string;
  TOSS_SECRET_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

function parseEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadEnv(): Env {
  const merged = {
    ...parseEnvFile(join(__dirname, "..", "..", "infinite-buy", ".env")),
    ...parseEnvFile(join(__dirname, "..", ".env")),
    ...process.env,
  } as Record<string, string>;
  const need = ["TOSS_API_KEY", "TOSS_SECRET_KEY"];
  for (const k of need) if (!merged[k]) throw new Error(`env 누락: ${k}`);
  return merged as unknown as Env;
}

// ---------- 저수준 HTTP ----------
function request(opts: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts, hostname: TOSS_HOST, agent: ipv4Agent }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json: any = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* keep raw */ }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${opts.method} ${opts.path}: ${data.slice(0, 400)}`));
        } else resolve(json);
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function getToken(env: Env): Promise<string> {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(env.TOSS_API_KEY)}&client_secret=${encodeURIComponent(env.TOSS_SECRET_KEY)}`;
  const j = await request(
    { method: "POST", path: "/oauth2/token", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
    body,
  );
  const token = j?.access_token;
  if (!token) throw new Error("토큰 발급 실패: " + JSON.stringify(j).slice(0, 200));
  return token;
}

function authGet(token: string, path: string, accountSeq?: number): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (accountSeq != null) headers["X-Tossinvest-Account"] = String(accountSeq);
  return request({ method: "GET", path, headers });
}

function authPost(token: string, path: string, bodyObj: any, accountSeq?: number): Promise<any> {
  const body = JSON.stringify(bodyObj);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  if (accountSeq != null) headers["X-Tossinvest-Account"] = String(accountSeq);
  return request({ method: "POST", path, headers }, body);
}

// ---------- 고수준 API ----------

export interface USCalendar {
  todayDate: string;       // KST 기준 오늘 날짜
  regularOpen: boolean;    // 오늘 미국 정규장 운영 여부
  previousBusinessDate: string;
}

export async function getUSCalendar(token: string): Promise<USCalendar> {
  const j = await authGet(token, "/api/v1/market-calendar/US");
  const r = j.result;
  return {
    todayDate: r.today?.date,
    regularOpen: !!r.today?.regularMarket,
    previousBusinessDate: r.previousBusinessDay?.date,
  };
}

/** 최근 일봉 종가 (숫자). 방금 마감한 세션의 종가. */
export async function getDailyClose(token: string, symbol: string): Promise<{ date: string; close: number }> {
  const j = await authGet(token, `/api/v1/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=1&adjusted=false`);
  const c = j.result?.candles?.[0];
  if (!c) throw new Error(`일봉 조회 실패: ${symbol}`);
  return { date: String(c.timestamp).slice(0, 10), close: Number(c.closePrice) };
}

/** 매수가능금액 (USD) */
export async function getBuyingPowerUSD(token: string, accountSeq: number): Promise<number> {
  const j = await authGet(token, "/api/v1/buying-power?currency=USD", accountSeq);
  return Number(j.result?.cashBuyingPower ?? 0);
}

/** 특정 종목 보유 수량 (정합성 점검용) */
export async function getHoldingQty(token: string, accountSeq: number, symbol: string): Promise<number> {
  const j = await authGet(token, `/api/v1/holdings?symbol=${encodeURIComponent(symbol)}`, accountSeq);
  const item = (j.result?.items ?? []).find((it: any) => it.symbol === symbol);
  return item ? Number(item.quantity) : 0;
}

export interface OrderStatus {
  status: string;        // FILLED / PARTIALLY_FILLED / OPEN / CANCELED ...
  filledQty: number;
  avgFilledPrice: number;
}

export async function getOrder(token: string, accountSeq: number, orderId: string): Promise<OrderStatus> {
  const j = await authGet(token, `/api/v1/orders/${encodeURIComponent(orderId)}`, accountSeq);
  const r = j.result ?? {};
  const ex = r.execution ?? {};
  return {
    status: r.status ?? "UNKNOWN",
    filledQty: Number(ex.filledQuantity ?? 0),
    avgFilledPrice: Number(ex.averageFilledPrice ?? 0),
  };
}

/** US 가격 포맷: $1이상 소수2, 미만 소수4 (문자열) */
function fmtPrice(price: number): string {
  const dec = price >= 1 ? 2 : 4;
  return price.toFixed(dec);
}

export interface PlaceResult { orderId: string; clientOrderId: string; }

/** LOC 주문 제출 (LIMIT + CLS). 반환: orderId */
export async function placeLocOrder(token: string, accountSeq: number, o: PlannedOrder): Promise<PlaceResult> {
  const body = {
    symbol: o.symbol,
    side: o.side,
    orderType: "LIMIT",
    timeInForce: "CLS",
    quantity: String(o.qty),
    price: fmtPrice(o.price),
    clientOrderId: o.clientOrderId,
  };
  const j = await authPost(token, "/api/v1/orders", body, accountSeq);
  const orderId = j?.result?.orderId;
  if (!orderId) throw new Error("주문 생성 실패: " + JSON.stringify(j).slice(0, 300));
  return { orderId, clientOrderId: j.result.clientOrderId ?? o.clientOrderId };
}
