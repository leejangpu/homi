/**
 * KIS API 클라이언트 — GitHub Actions용 (최소 추출)
 * 원본: server/src/lib/kisApi.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = 'https://openapi.koreainvestment.com:9443';

// 주문/잔고용 (4자리) → 시세조회용 (3자리)
const QUOTE_EXCHANGE_MAP: Record<string, string> = {
  NASD: 'NAS',
  AMEX: 'AMS',
  NYSE: 'NYS',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = path.resolve(__dirname, '..', 'state', 'token.json');

// ==================== 타입 ====================

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface BalanceResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: Array<{
    ovrs_pdno: string;
    ovrs_item_name: string;
    frcr_evlu_pfls_amt: string;
    evlu_pfls_rt: string;
    pchs_avg_pric: string;
    ovrs_cblc_qty: string;
    ovrs_stck_evlu_amt: string;
    now_pric2: string;
    frcr_pchs_amt1: string;
    ovrs_excg_cd: string;
  }>;
  output2?: Array<{
    ovrs_tot_pfls: string;
    frcr_pchs_amt1: string;
    tot_evlu_pfls_amt: string;
    tot_asst_amt: string;
  }>;
}

export interface QuoteResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    last: string;
    base: string;
    sign: string;
    diff: string;
    rate: string;
    tvol: string;
    ordy: string;
  };
}

export interface OrderResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    KRX_FWDG_ORD_ORGNO: string;
    ODNO: string;
    ORD_TMD: string;
  };
}

export interface BuyableAmountResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    ovrs_ord_psbl_amt: string;
    frcr_ord_psbl_amt1: string;
  };
}

export interface OrderHistoryResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: Array<{
    ord_dt: string;
    odno: string;
    sll_buy_dvsn_cd: string;
    pdno: string;
    prdt_name: string;
    ft_ord_qty: string;
    ft_ord_unpr3: string;
    ft_ccld_qty: string;
    ft_ccld_unpr3: string;
    ft_ccld_amt3: string;
    nccs_qty: string;
    prcs_stat_name: string;
    rjct_rson_name: string;
    ovrs_excg_cd: string;
  }>;
}

export interface ReservationOrderResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    ODNO: string;
    ORD_TMD: string;
  };
}

// ==================== KIS API 클라이언트 ====================

export class KisApiClient {
  /**
   * 접근 토큰 발급 (파일 캐싱, 만료 1시간 전 갱신)
   */
  async getAccessToken(appKey: string, appSecret: string): Promise<string> {
    // 캐시 파일 확인
    if (fs.existsSync(TOKEN_CACHE_PATH)) {
      try {
        const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8'));
        if (cached.access_token && cached.expires_at) {
          const now = Math.floor(Date.now() / 1000);
          if (now < cached.expires_at) {
            console.log(`[KIS] 캐시된 토큰 사용 (만료: ${new Date(cached.expires_at * 1000).toISOString()})`);
            return cached.access_token;
          }
        }
      } catch {
        // 캐시 파싱 실패 시 새로 발급
      }
    }

    const response = await fetch(`${BASE_URL}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        appsecret: appSecret,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Token request failed: ${response.status} - ${errorBody}`);
    }

    const data: TokenResponse = await response.json();
    const now = Math.floor(Date.now() / 1000);
    const expires_at = now + data.expires_in - 3600;

    // 캐시 디렉토리 생성 및 저장
    fs.mkdirSync(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ access_token: data.access_token, expires_at }, null, 2), 'utf-8');

    console.log(`[KIS] 새 토큰 발급 완료 (만료: ${new Date(expires_at * 1000).toISOString()})`);
    return data.access_token;
  }

  /**
   * 해외주식 잔고 조회 (지정된 거래소 목록 병합)
   */
  async getBalance(
    appKey: string, appSecret: string, accessToken: string, accountNo: string,
    exchanges: string[]
  ): Promise<BalanceResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    const fetchOne = async (exchange: string): Promise<BalanceResponse> => {
      const response = await fetch(
        `${BASE_URL}/uapi/overseas-stock/v1/trading/inquire-balance?` +
          new URLSearchParams({
            CANO: accountPrefix, ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchange, TR_CRCY_CD: 'USD',
            CTX_AREA_FK200: '', CTX_AREA_NK200: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: 'TTTS3012R',
          },
        }
      );
      if (!response.ok) throw new Error(`Balance request failed for ${exchange}: ${response.status}`);
      return response.json();
    };

    const mergedOutput1: NonNullable<BalanceResponse['output1']> = [];
    let output2: BalanceResponse['output2'] = [];

    for (let i = 0; i < exchanges.length; i++) {
      if (i > 0) await delay(300);
      try {
        const result = await fetchOne(exchanges[i]);
        if (Array.isArray(result.output1)) {
          for (const item of result.output1) {
            if (!mergedOutput1.some(x => x.ovrs_pdno === item.ovrs_pdno)) {
              mergedOutput1.push(item);
            }
          }
        }
        if (!output2?.length && Array.isArray(result.output2) && result.output2.length > 0) {
          output2 = result.output2;
        }
      } catch (err) {
        console.error(`[Balance] ${exchanges[i]} failed:`, err);
      }
    }

    return { rt_cd: '0', msg_cd: '', msg1: '', output1: mergedOutput1, output2 };
  }

  /**
   * 해외주식 매수가능금액 조회
   */
  async getBuyableAmount(
    appKey: string, appSecret: string, accessToken: string,
    accountNo: string, ticker: string, price: number, exchange: string = 'NASD'
  ): Promise<BuyableAmountResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    const response = await fetch(
      `${BASE_URL}/uapi/overseas-stock/v1/trading/inquire-psamount?` +
        new URLSearchParams({
          CANO: accountPrefix, ACNT_PRDT_CD: accountSuffix,
          OVRS_EXCG_CD: exchange, OVRS_ORD_UNPR: String(price), ITEM_CD: ticker,
        }),
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          authorization: `Bearer ${accessToken}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: 'TTTS3007R',
        },
      }
    );
    if (!response.ok) throw new Error(`Buyable amount request failed: ${response.status}`);
    return response.json();
  }

  /**
   * 해외주식 현재가 조회
   */
  async getCurrentPrice(
    appKey: string, appSecret: string, accessToken: string, ticker: string, exchange: string
  ): Promise<number> {
    const quoteExchange = QUOTE_EXCHANGE_MAP[exchange] ?? exchange;
    const response = await fetch(
      `${BASE_URL}/uapi/overseas-price/v1/quotations/price?` +
        new URLSearchParams({ AUTH: '', EXCD: quoteExchange, SYMB: ticker }),
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          authorization: `Bearer ${accessToken}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: 'HHDFS00000300',
        },
      }
    );
    if (!response.ok) throw new Error(`Quote request failed for ${ticker}: ${response.status}`);
    const data: QuoteResponse = await response.json();
    const price = parseFloat(data.output?.last || '0');
    if (price <= 0) throw new Error(`Invalid price for ${ticker}: ${data.output?.last}`);
    return price;
  }

  /**
   * 해외주식 주문 (LOC/LIMIT/MOC/MOO)
   */
  async submitOrder(
    appKey: string, appSecret: string, accessToken: string, accountNo: string,
    params: {
      ticker: string;
      side: 'BUY' | 'SELL';
      orderType: 'LOC' | 'LIMIT' | 'MOC' | 'MOO';
      price: number;
      quantity: number;
      exchange: string;
    }
  ): Promise<OrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    const trId = params.side === 'BUY' ? 'TTTT1002U' : 'TTTT1006U';
    const orderTypeMap: Record<string, string> = {
      'MOO': '31', 'MOC': '33', 'LOC': '34',
    };
    const orderTypeCode = orderTypeMap[params.orderType] || '00';
    const exchangeCode = params.exchange;

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await delay(500);
          console.log(`[Order] Retry ${attempt}/${maxRetries} for ${params.ticker} ${params.side}`);
        }
        const response = await fetch(`${BASE_URL}/uapi/overseas-stock/v1/trading/order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: trId,
          },
          body: JSON.stringify({
            CANO: accountPrefix, ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchangeCode, PDNO: params.ticker,
            ORD_QTY: String(params.quantity),
            OVRS_ORD_UNPR: params.orderType === 'MOO' || params.orderType === 'MOC'
              ? '0' : String(params.price.toFixed(2)),
            SLL_TYPE: params.side === 'SELL' ? '00' : '',
            ORD_SVR_DVSN_CD: '0',
            ORD_DVSN: orderTypeCode,
          }),
        });
        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Order failed: ${response.status} - ${errorBody}`);
        }
        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[Order] Attempt ${attempt} failed:`, lastError.message);
      }
    }
    throw lastError!;
  }

  /**
   * 해외주식 주문체결내역 조회
   */
  async getOrderHistory(
    appKey: string, appSecret: string, accessToken: string, accountNo: string,
    date: string, ccldNccsDvsn: string = '00'
  ): Promise<OrderHistoryResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    const response = await fetch(
      `${BASE_URL}/uapi/overseas-stock/v1/trading/inquire-ccnl?` +
        new URLSearchParams({
          CANO: accountPrefix, ACNT_PRDT_CD: accountSuffix,
          PDNO: '%', ORD_STRT_DT: date, ORD_END_DT: date,
          SLL_BUY_DVSN: '00', CCLD_NCCS_DVSN: ccldNccsDvsn,
          OVRS_EXCG_CD: '%', SORT_SQN: 'AS',
          ORD_DT: '', ORD_GNO_BRNO: '', ODNO: '',
          CTX_AREA_NK200: '', CTX_AREA_FK200: '',
        }),
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          authorization: `Bearer ${accessToken}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: 'TTTS3035R',
        },
      }
    );
    if (!response.ok) throw new Error(`Order history request failed: ${response.status}`);
    return response.json();
  }

  /**
   * 해외주식 예약주문 (MOO 매도용)
   */
  async submitReservationOrder(
    appKey: string, appSecret: string, accessToken: string, accountNo: string,
    params: { ticker: string; side: 'SELL'; quantity: number; orderType: 'MOO'; exchange: string }
  ): Promise<ReservationOrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    const exchangeCode = params.exchange;

    const response = await fetch(`${BASE_URL}/uapi/overseas-stock/v1/trading/order-resv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        authorization: `Bearer ${accessToken}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'TTTT3016U',
      },
      body: JSON.stringify({
        CANO: accountPrefix, ACNT_PRDT_CD: accountSuffix,
        OVRS_EXCG_CD: exchangeCode, PDNO: params.ticker,
        FT_ORD_QTY: String(params.quantity),
        FT_ORD_UNPR3: '0',
        ORD_SVR_DVSN_CD: '0',
        ORD_DVSN: '31',
      }),
    });
    if (!response.ok) throw new Error(`Reservation order failed: ${response.status}`);
    return response.json();
  }

}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
