// 떨사오팔 타입 정의. SPEC.md §9 참고.

export interface Config {
  enabled: boolean;
  symbol: string;
  splits: number;            // n분할 (기본 7)
  sellProfitRate: number;    // 이익매도 마진 (0.003 = 0.3%)
  stopLossOpenDays: number;  // 손절 영업일 (12)
  stopSellDiscount: number;  // 저가 LOC 종가매도 할인폭 (0.30)
  capitalSource: string;     // "toss_buyable"
  accountSeq: number;        // X-Tossinvest-Account
}

// 보유 로트 ("떨")
export interface Lot {
  id: string;
  buyDate: string;   // YYYY-MM-DD (체결일)
  buyPrice: number;  // 체결가 (= 매수 당일 종가)
  qty: number;       // 체결 수량 (정수)
  daysHeld: number;  // 매수일=0, 마감 지날 때마다 +1
}

export interface CycleState {
  symbol: string;
  cycleSeq: number;
  splits: number;
  splitAmount: number;    // 사이클 시작 시 고정된 1분할 상한
  cycleStartCash: number; // 참고용 스냅샷
  lots: Lot[];
  prevClose: number | null; // 다음날 매수 기준선 (직전 마감 종가)
  plannedOrders: PlannedOrder[];   // main-close가 계획 → main-open이 소비
  submittedOrders: SubmittedOrder[]; // main-open이 제출 → main-close가 체결 대조
  lastCloseDate?: string;  // 마지막으로 마감 반영한 거래일 (멱등 처리)
  cycleBuyCost?: number;   // 현 사이클 매수 체결금 누적 (USD)
  cycleSellProceeds?: number; // 현 사이클 매도/손절 체결금 누적 (USD)
  cycleReport?: CycleReport;  // 이번 마감에 사이클이 끝났다면 그 요약 (없으면 미종료)
  updatedAt: string;
}

// 사이클 종료 요약 (실현 손익)
export interface CycleReport {
  cycleSeq: number;    // 종료된 사이클 번호
  endDate: string;
  bought: number;      // 매수 체결금 합계 (USD)
  sold: number;        // 매도/손절 체결금 합계 (USD)
  profit: number;      // sold - bought (USD)
  returnPct: number;   // profit / bought * 100
}

// main-open이 실제 제출한 주문 (체결 대조용 orderId 포함)
export interface SubmittedOrder extends PlannedOrder {
  orderId: string;
  submitDate: string;
}

export type OrderSide = "BUY" | "SELL";
export type OrderKind = "buy" | "profit_sell" | "stop_sell";

// 다음 개장일에 제출할 주문 계획 (모두 LOC = LIMIT + CLS)
export interface PlannedOrder {
  kind: OrderKind;
  side: OrderSide;
  symbol: string;
  price: number;   // 지정가 (틱 반올림 완료)
  qty: number;     // 정수 주
  lotId?: string;  // 매도/손절이면 대상 로트
  clientOrderId: string; // 멱등성 키
}

// main-open이 제출 후 main-close가 다시 조회하는 체결 결과 (토스 order-info/holdings 기반)
export interface FillResult {
  clientOrderId: string;
  kind: OrderKind;
  lotId?: string;
  filledQty: number;   // 체결 수량 (0이면 미체결)
  filledPrice: number; // 체결가 (종가). filledQty>0일 때만 유효
}

// main-close 하루치 마감 입력
export interface CloseContext {
  today: string;         // YYYY-MM-DD (미국 거래일)
  todayClose: number;    // 오늘 종가 (= 내일 prevClose, 매수 체결 기준)
  availableCash: number; // 토스 매수가능금액 (USD)
  fills: FillResult[];   // 오늘 제출분 체결 결과
}
