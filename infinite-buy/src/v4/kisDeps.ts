/**
 * V4.0 실서버 의존성 빌더 + 설정/자격증명 로더 + ⚠️ 실주문 게이트
 *
 * 실주문 게이트(3중):
 *  1) config-v4.json enabled (production.ts에서 체크)
 *  2) 환경변수 V4_LIVE_ORDERS === 'YES_REALLY' 가 아니면 submitOrder는 DRY-RUN(로그만)
 *  3) DRY-RUN 시 kis.submitOrder 자체를 호출하지 않음
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { KisApiClient } from '../kisApi.js';
import type { V4Config, V4Deps } from './production.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export function loadV4Config(): V4Config {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config-v4.json'), 'utf-8'));
}
export function loadCreds() {
  return { appKey: process.env.KIS_APP_KEY || '', appSecret: process.env.KIS_APP_SECRET || '', accountNo: process.env.KIS_ACCOUNT_NO || '' };
}
export function isLive(): boolean { return process.env.V4_LIVE_ORDERS === 'YES_REALLY'; }

export async function buildRealDeps(cfg: V4Config, creds: ReturnType<typeof loadCreds>): Promise<V4Deps> {
  const kis = new KisApiClient();
  const token = await kis.getAccessToken(creds.appKey, creds.appSecret);
  const exchanges = Array.from(new Set(cfg.tickers.map(t => cfg.tickerConfigs[t].exchange)));

  return {
    async getBalances() {
      const bal = await kis.getBalance(creds.appKey, creds.appSecret, token, creds.accountNo, exchanges);
      return (bal.output1 || []).map(h => ({
        ticker: h.ovrs_pdno,
        shares: parseInt(h.ovrs_cblc_qty || '0'),
        avgPrice: parseFloat(h.pchs_avg_pric || '0'),
        currentPrice: parseFloat(h.now_pric2 || '0'),
      }));
    },
    async getCurrentPrice(ticker, exchange) {
      return kis.getCurrentPrice(creds.appKey, creds.appSecret, token, ticker, exchange);
    },
    async getDailyCloses(ticker, exchange, count) {
      return kis.getDailyClosingPrices(creds.appKey, creds.appSecret, token, ticker, exchange, count);
    },
    async getAvailableCashUSD() {
      // 외화 주문가능금액(USD 예수금 상당). 임의 종목/가격으로 조회 (금액은 종목 무관).
      const t = cfg.tickers[0];
      const ex = cfg.tickerConfigs[t].exchange;
      const r = await kis.getBuyableAmount(creds.appKey, creds.appSecret, token, creds.accountNo, t, 1, ex);
      return parseFloat(r.output?.frcr_ord_psbl_amt1 || r.output?.ovrs_ord_psbl_amt || '0');
    },
    async submitOrder(o) {
      const desc = `${o.side} ${o.orderType} ${o.ticker} ${o.quantity}주 @ $${o.price}`;
      if (!isLive()) {
        console.log(`  🟡 [V4 DRY-RUN] 미제출(로그만): ${desc}`);
        return;
      }
      console.log(`  🔴 [V4 LIVE] 실주문 제출: ${desc}`);
      await kis.submitOrder(creds.appKey, creds.appSecret, token, creds.accountNo, {
        ticker: o.ticker, side: o.side, orderType: o.orderType, price: o.price, quantity: o.quantity, exchange: o.exchange,
      });
    },
  };
}
