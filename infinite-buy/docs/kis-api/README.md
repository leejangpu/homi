# KIS 해외주식 OpenAPI — 사용 엔드포인트 로컬 레퍼런스

한국투자증권(KIS) 오픈API 공식 샘플코드 사본. `infinite-buy/src/kisApi.ts`가 실제로 호출하는 엔드포인트만 추려 보관한다.
출처: [koreainvestment/open-trading-api](https://github.com/koreainvestment/open-trading-api) `examples_llm/overseas_stock/`.
각 폴더의 `<name>.py`(호출/파라미터)와 `chk_<name>.py`(응답 컬럼 매핑)를 보면 요청·응답 필드명을 확인할 수 있다.

| kisApi.ts 메서드 | 엔드포인트 | tr_id | 로컬 샘플 |
|---|---|---|---|
| `getCurrentPrice` | `/uapi/overseas-price/v1/quotations/price` | HHDFS00000300 | [price/](price/) |
| `getDailyClosingPrices` (V4 리버스 5일평균) | `/uapi/overseas-price/v1/quotations/dailyprice` | HHDFS76240000 | [dailyprice/](dailyprice/) |
| `getBalance` | `/uapi/overseas-stock/v1/trading/inquire-balance` | TTTS3012R | [inquire_balance/](inquire_balance/) |
| `getBuyableAmount` (예수금/매수가능) | `/uapi/overseas-stock/v1/trading/inquire-psamount` | TTTS3007R | [inquire_psamount/](inquire_psamount/) |
| `submitOrder` | `/uapi/overseas-stock/v1/trading/order` | 매수 TTTT1002U / 매도 TTTT1006U | [order/](order/) |
| `getOrderHistory` | `/uapi/overseas-stock/v1/trading/inquire-ccnl` | TTTS3035R | [inquire_ccnl/](inquire_ccnl/) |
| `submitReservationOrder` | `/uapi/overseas-stock/v1/trading/order-resv` | TTTT3016U(코드) / 샘플 TTTT3014U | [order_resv/](order_resv/) |

## V4 관련 확인된 필드 (dailyprice)
- 요청 params: `AUTH, EXCD, SYMB, GUBN(0=일), BYMD(공란=오늘), MODP`
- 응답 `output2`(일별 배열): `xymd`(일자 YYYYMMDD), `clos`(종가), `sign/diff/rate/tvol …`
- → `getDailyClosingPrices`가 `output2`를 시간순 정렬해 최근 종가 배열 반환.

## 예수금 (inquire_psamount)
- 응답 `output.frcr_ord_psbl_amt1`(외화 주문가능금액) → V4 `getAvailableCashUSD`가 사용.

> ⚠️ 모의투자(VTS) tr_id는 실전과 다를 수 있음. 현재 코드/샘플 tr_id는 **실전(TTTT/TTTS/HHDFS) 기준**.
