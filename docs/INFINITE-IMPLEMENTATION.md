# 무한매수법(Infinite DCA) 매매법 구현 문서

## 1. 무한매수법 개요

### 1.1 핵심 개념
무한매수법(Infinite DCA)은 레버리지 ETF(TQQQ, SOXL 등)를 대상으로 분할 매수를 통한 평단가 하락과 목표가 익절을 반복하는 규칙 기반 자동 매매 전략입니다.

### 1.2 전략 목적
- **대상 종목**: 레버리지 ETF (TQQQ, SOXL 등)
- **투자 방식**: 분할 매수를 통한 평단가 하락 + 목표가 익절
- **핵심 철학**: 차트/기업 분석 없이 수학적 규칙 기반 자동 매매

### 1.3 핵심 공식
```
T = 매수누적액 / 1회매수액 (소수점 둘째자리 올림)

별% = 목표수익률 - (T × 감소율)
감소율 = 목표수익률 × 2 / 분할수

별% LOC 주문가 = 평단가 × (1 + 별%)

예시 (V3.0 TQQQ 20분할):
- 감소율 = 0.15 × 2 / 20 = 0.015 (1.5%)
- T=5일 때 별% = 15% - (5 × 1.5%) = 7.5%
```

### 1.4 주요 특징
- ✅ 분할 매수로 리스크 분산
- ✅ 하락장에서 평단 하락 효과
- ✅ 변동성 활용한 수익 실현
- ⚠️ 레버리지 상품 특성상 급격한 하락에 취약

---

## 2. 핵심 용어

### 2.1 T (회차)
```
T = 매수누적액 / 1회매수액 (소수점 둘째자리 올림)
```
- 현재까지 몇 번째 매수인지를 나타내는 지표
- 예: 1회매수액이 $1,000이고 누적 $15,000 매수 → T=15

### 2.2 별%(☆%) - LOC 매수/매도 기준점
```
별% = 평단가 기준 LOC 주문 가격의 퍼센트
```
- 매일 달라지는 매수/매도 기준 가격
- T값에 따라 동적으로 계산됨

### 2.3 전반전 vs 후반전
| 버전 | 전반전 | 후반전 |
|------|--------|--------|
| V2.2 (40분할) | T < 20 | T ≥ 20 |
| V3.0 (20분할) | T < 10 | T ≥ 10 |

### 2.4 분할 방식
- **40분할**: 안정적, 초보자 권장 (V2.2)
- **20분할**: 공격적, 고수익/고위험 (V3.0)
- **30분할, 35분할**: 커스텀 가능

---

## 3. 버전별 특징

### 3.1 V2.2 (안정 버전, 2023년)

#### 기본 설정
| 항목 | TQQQ | SOXL |
|------|------|------|
| 분할수 | 40 | 40 |
| 목표 수익률 | 10% | 12~20% |
| 별% 공식 | 10 - T/2 | 10 - T/2 × (40/a) |

#### 특징
- 40분할 기준
- 전후반전 매수 방식이 명확히 구분됨
- 쿼터손절 모드 (T > 39)

### 3.2 V3.0 (최신 버전, 2024년 6월)

#### 기본 설정
| 항목 | TQQQ | SOXL |
|------|------|------|
| 분할수 | 20 | 20 |
| 목표 수익률 | 15% | 20% |
| 별% 공식 | 15 - 1.5T | 20 - 2T |

#### 주요 변경사항
1. **반복리(Half Compounding) 도입**
   - 수익금을 40분할하여 1회매수금에 반영
   - 예: $200 수익 → $200/40 = $5 → 1회매수금 $1,000 → $1,005
   - 20분할 진행 시 수익금의 절반(20/40)만 사용 → 나머지 절반은 비상금

2. **손실 시 매수금 유지**
   - 손실 발생 시에도 과거 수익 최대치 기준으로 1회매수금 유지
   - 자금 부족 시 보관된 비상금에서 충당

3. **쿼터매도로 용어 통일**
   - 기존 "쿼터손절" 대신 "쿼터매도"로 변경

---

## 4. 매수 규칙

### 4.1 V2.2 매수 규칙

#### 전반전 매수 (T < 20)
```javascript
const 별퍼센트 = 10 - T/2;

주문1: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 0/100)  // 0%LOC = 평단가
}

주문2: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100) - 0.01  // 매도와 겹치지 않도록
}
```

#### 후반전 매수 (T ≥ 20)
```javascript
const 별퍼센트 = 10 - T/2;

주문1: {
  금액: 1회매수금,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100) - 0.01
}
```

### 4.2 V3.0 매수 규칙

#### 전반전 매수 (T < 10)
```javascript
const 별퍼센트 = (종목 === 'TQQQ') ? 15 - 1.5 * T : 20 - 2.0 * T;

주문1: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100)
}

주문2: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 0/100)  // 0%LOC = 평단가
}

// 추가 하방 매수 (급락 대비)
// 평단가보다 낮은 가격대에 여러 LOC 주문 배치
```

#### 후반전 매수 (T ≥ 10)
```javascript
const 별퍼센트 = (종목 === 'TQQQ') ? 15 - 1.5 * T : 20 - 2.0 * T;

주문1: {
  금액: 1회매수금,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100)
}

// 추가 하방 매수 (급락 대비)
```

### 4.3 매수 예시 (V3.0 TQQQ)

| T값 | 별% | 평단가 $50 기준 별% LOC 가격 |
|-----|-----|---------------------------|
| 1 | 13.5% | $56.75 |
| 5 | 7.5% | $53.75 |
| 10 | 0% | $50.00 |
| 15 | -7.5% | $46.25 |
| 19 | -13.5% | $43.25 |

---

## 5. 매도 규칙

### 5.1 일반 매도 (T ≤ 19 또는 T ≤ 39)

**V2.2 및 V3.0 공통 (전후반전 무관)**
```javascript
const 목표수익률 = (버전 === 'V3.0')
  ? (종목 === 'TQQQ' ? 15 : 20)
  : (종목 === 'TQQQ' ? 10 : 20);

// 매일 아래 2개 매도 주문을 같이 걸어둠

주문1_쿼터매도: {
  수량: 누적수량 / 4,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100),
  설명: '별%LOC 쿼터매도 - 수익 구간에서 1/4 수익 실현'
}

주문2_목표익절: {
  수량: 누적수량 * 3/4,
  타입: 'LIMIT',
  가격: 평단가 * (1 + 목표수익률/100),
  설명: '목표 수익률 달성 시 3/4 익절'
}
```

### 5.2 쿼터모드 매도 (V3.0: 19 < T < 20)

**T값 기반 판단 (상태 플래그 불필요)**
```javascript
function generate_sell_orders(T값, 별퍼센트, 잔금, 1회매수금) {
  if (T값 > 19) {
    // 쿼터모드 (19 < T < 20): MOC 강제 매도
    return {
      주문1_쿼터매도MOC: {
        수량: 누적수량 / 4,
        타입: 'MOC',  // Market On Close (무조건 시장가 매도)
        설명: '자금 확보를 위한 강제 매도'
      },
      주문2_목표익절: {
        수량: 누적수량 * 3/4,
        타입: 'LIMIT',
        가격: 평단가 * (1 + 목표수익률/100)
      }
    }
  }

  else if (잔금 < 1회매수금) {
    // 잔금 부족 시: MOC 매도로 자금 확보
    return {
      주문1_쿼터매도MOC: {
        수량: 누적수량 / 4,
        타입: 'MOC',
        설명: '잔금 부족으로 자금 확보'
      },
      주문2_목표익절: {
        수량: 누적수량 * 3/4,
        타입: 'LIMIT',
        가격: 평단가 * (1 + 목표수익률/100)
      }
    }
  }

  else {
    // 일반 매도: 별%LOC 쿼터매도
    return {
      주문1_쿼터매도LOC: {
        수량: 누적수량 / 4,
        타입: 'LOC',
        가격: 평단가 * (1 + 별퍼센트/100)
      },
      주문2_목표익절: {
        수량: 누적수량 * 3/4,
        타입: 'LIMIT',
        가격: 평단가 * (1 + 목표수익률/100)
      }
    }
  }
}

// 중요: "쿼터매도하는 그 날은, 매수시도는 없습니다"
```

### 5.3 쿼터손절 모드 (V2.2: 39 < T ≤ 40)

```javascript
// 1. 초기 진입: 1/4 강제 매도
주문_MOC: {
  수량: 누적수량 / 4,
  타입: 'MOC'
}

// 2. 매도 후 잔여 자금 + 수익금으로 10회 분할 매수금 계산
const 추가매수금 = Math.min(
  (잔여자금 + 기존수익금) / 10,
  기존_1회매수금  // 초과하지 않음
);

// 3. 1~10회 추가 매수 기간
매수주문: {
  금액: 추가매수금,
  타입: 'LOC',
  가격: 평단가 * (1 - 10/100)  // -10%LOC
}

쿼터매도: {
  수량: 누적수량 / 4,
  타입: 'LOC',
  가격: 평단가 * (1 - 10/100)  // -10%LOC
}

지정가매도: {
  수량: 누적수량 * 3/4,
  타입: 'LIMIT',
  가격: 평단가 * (1 + 10/100)  // 10% 익절
}

// 4. 10회 완료 후: 다시 1/4 MOC 매도
// - LOC 매도 성공 시 → 후반전 모드로 복귀
// - MOC 매도 시 → 쿼터손절 모드 반복
```

---

## 6. 주문 타입 정의

### 6.1 LOC (Limit On Close)
- **설명**: 종가에 지정가 이하/이상으로 체결
- **매수**: 종가가 지정가 이상일 때만 체결 (지정가로 매수)
- **매도**: 종가가 지정가 이상일 때만 체결 (종가로 매도)
- **장점**: 급등/급락 시 평단 보호
- **한투 코드**: 34

### 6.2 MOC (Market On Close)
- **설명**: 종가에 무조건 체결 (시장가)
- **용도**: 쿼터매도 강제 실행
- **한투 코드**: 32

### 6.3 LIMIT (지정가)
- **설명**: 지정가 도달 시 체결 (장중 실시간)
- **용도**: 목표 수익률 달성 시 익절
- **한투 코드**: 00

---

## 7. 구현된 파일 및 역할

### 7.1 백엔드 (idca-functions)

#### `src/lib/calculator.ts`
무한매수법 계산 로직 전담 모듈

**주요 타입:**
```typescript
type Phase = 'FIRST_HALF' | 'SECOND_HALF' | 'QUARTER_MODE';
type StrategyVersion = 'v2.2' | 'v3.0';

interface CalculateParams {
  ticker: string;
  currentPrice: number;
  totalQuantity: number;
  avgPrice: number;
  totalInvested: number;
  remainingCash: number;
  buyPerRound: number;
  splitCount: number;
  targetProfit: number;
  starDecreaseRate: number;
  strategyVersion?: StrategyVersion;
  quarterMode?: QuarterModeState;
}

interface CalculateResult {
  tValue: number;
  phase: Phase;
  phaseLabel: string;
  starPercent: number;
  targetPercent: number;
  buyOrders: BuyOrder[];
  sellOrders: SellOrder[];
  analysis: { ... };
  cycleStatus: { ... };
  quarterModeInfo?: { ... };
}
```

**주요 함수:**
- `calculate(params)`: 메인 계산 함수
- `calculateDecreaseRate(targetProfit, splitCount)`: 감소율 계산
- `shouldEnterQuarterMode(...)`: 쿼터모드 진입 조건 체크
- `calculateQuarterModeSeed(...)`: 쿼터모드 시드 계산
- `getDefaultSettingsForVersion(version, ticker)`: 버전별 기본 설정

#### `src/lib/principalCalculator.ts`
투자원금 계산 및 추가 입금 균등 분배

**주요 함수:**
- `calculatePrincipal(input)`: 전체 원금 계산 메인 함수
- `calculateTotalAllocatedFunds(...)`: 기존 배분 자금 합계
- `calculateAdditionalDeposit(...)`: 추가 입금액 계산
- `calculateDepositPerTicker(...)`: 종목별 추가입금 배분액

#### `src/lib/kisApi.ts`
한국투자증권 API 클라이언트

**주문 관련 메서드:**
- `submitOrder(...)`: 해외주식 주문 제출 (LOC, MOC, LIMIT)
- `getBuyableAmount(...)`: 매수 가능 금액 조회
- `getOrderHistory(...)`: 주문 체결 내역 조회
- `getPendingOrders(...)`: 미체결 내역 조회

**TR_ID 코드:**
| 주문 유형 | 실전 | 모의 |
|----------|------|------|
| 매수 | TTTT1002U | VTTT1002U |
| 매도 | TTTT1006U | VTTT1001U |

#### `src/lib/telegram.ts`
텔레그램 봇 알림 서비스

**주요 함수:**
- `notifyOrderPending(...)`: 주문 대기 알림 (승인/거부 버튼)
- `notifyAutoOrder(...)`: 자동 주문 알림
- `notifyCombinedOrderPending(...)`: 복합(매수+매도) 주문 대기 알림
- `notifyOrderExecuted(...)`: 주문 실행 결과 알림
- `notifyCycleCompleted(...)`: 사이클 완료 알림

#### `src/index.ts`
Firebase Functions 진입점

**주요 함수:**

| 함수 | 역할 | 실행 시점 |
|------|------|----------|
| `processAccountTrading()` | 사이클 상태 점검/초기화 → 주문 계산 → 주문 생성 | 장 개시 (UTC 09:00) |
| `executeApprovedOrder()` | 순수 KIS API 주문 실행 + 주문 기록 | 주문 승인 시 |
| `marketCloseTrigger()` | 체결 기반 동기화 (수익, 쿼터모드, 사이클 완료) | 장 마감 (UTC 21:00) |

> **아키텍처 원칙**: 주문의 체결 결과 확인, 수익 계산, 쿼터모드 전환, 사이클 완료 감지 등 **실제 거래 결과에 기반한 Firestore 업데이트는 장 마감 트리거(`marketCloseTrigger`)에서 수행**한다. 단, 새 사이클 초기화는 주문 계산 전에 `processAccountTrading`에서 수행한다. 주문 실행 경로(`executeApprovedOrder`)에서는 사이클 상태를 변경하지 않는다.

---

### 7.2 프론트엔드 (idca-web)

#### `src/lib/firestore.ts`
Firestore 서비스 함수

**추가된 타입:**
```typescript
interface CycleData {
  ticker: string;
  status: 'active' | 'completed';
  principal: number;
  totalInvested: number;
  totalQuantity: number;
  avgPrice: number;
  remainingCash: number;
  buyPerRound: number;
  splitCount: number;
  targetProfit: number;
  strategyVersion: 'v2.2' | 'v3.0';
  // ...
}

interface UserTradingConfig {
  tradingEnabled: boolean;
  approvalMode: 'manual' | 'auto';
  tickers: string[];
  tickerConfigs: Record<string, TickerConfig>;
}
```

---

## 8. Firestore 스키마

### 8.1 사이클 데이터
**경로**: `users/{userId}/accounts/{accountId}/cycles/{ticker}`
```typescript
{
  ticker: string,
  status: 'active' | 'completed',
  principal: number,           // 사이클 원금 (시작 시 결정, 사이클 중 불변)
  totalInvested: number,       // 누적 투자액
  totalQuantity: number,       // 보유 수량
  avgPrice: number,            // 평균 단가
  remainingCash: number,       // 잔여 현금
  buyPerRound: number,         // 1회 매수금
  splitCount: number,          // 분할 수 (20 또는 40)
  targetProfit: number,        // 목표 수익률 (0.10, 0.15, 0.20)
  totalRealizedProfit: number, // 누적 실현수익 (총매도 - 총매수)
  totalBuyAmount: number,      // 누적 매수 체결금액 (장 마감 동기화)
  totalSellAmount: number,     // 누적 매도 체결금액 (장 마감 동기화)
  strategyVersion: 'v2.2' | 'v3.0',

  // V3.0 전용
  maxProfit: number,           // 과거 수익 최대치
  reservedProfit: number,      // 보관된 수익금 (반복리용)

  // 쿼터모드 (V2.2 전용)
  quarterMode?: {
    isActive: boolean,         // true: 활성화됨, false: MOC 체결 대기 (pending)
    round: number,             // 쿼터 매수 회차
    seed: number,              // 쿼터모드 시드 금액
    buyPerRound: number        // 쿼터 1회 매수금
  },

  startedAt: Timestamp,
  updatedAt: Timestamp,
  syncedAt?: Timestamp         // 장 마감 동기화 시각
}
```

### 8.2 사용자 설정
**경로**: `users/{userId}/accounts/{accountId}/config/trading`
```typescript
{
  tradingEnabled: boolean,
  approvalMode: 'manual' | 'auto',
  tickers: string[],           // ['TQQQ', 'SOXL']
  tickerConfigs: {
    TQQQ: {
      enabled: boolean,
      stopAfterCycleEnd: boolean, // 사이클 종료 후 새 사이클 자동 시작 방지
      principal?: number,      // 수동 설정 원금 (undefined = 자동 모드)
      splitCount: number,
      targetProfit: number,
      strategyVersion: string
    }
  }
}
```

### 8.3 대기 주문
**경로**: `pendingOrders/{orderId}`
```typescript
{
  id: string,
  userId: string,
  accountId: string,
  ticker: string,
  side: 'BUY' | 'SELL',
  orderType: 'LOC' | 'MOC' | 'LIMIT',
  price: number,
  quantity: number,
  amount: number,

  // 계산 정보
  tValue: number,
  starPercent: number,
  avgPrice: number,

  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed',
  telegramMessageId?: number,

  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

### 8.4 config와 cycleData 분리 원칙

**핵심 규칙**: 사용자 설정(config)과 사이클 런타임 데이터(cycleData)는 완전히 분리되어야 한다.

| 구분 | 저장 위치 | 용도 | 변경 주체 |
|------|----------|------|----------|
| 사용자 설정 | `config.tickerConfigs[ticker]` | 다음 사이클 매매 설정 | 프론트엔드 (사용자) |
| 사이클 데이터 | `cycles/{ticker}` | 진행 중인 사이클 상태 | 백엔드 (매매 로직) |

**원금 설정 (principal)**:
- `config.tickerConfigs[ticker].principal`: 사용자가 수동 설정한 다음 사이클 원금 (`undefined` = 자동 모드)
- `cycleData.principal`: 현재 사이클의 시작 원금 (사이클 시작 시 결정)
- `cycleData.totalRealizedProfit`: 현재 사이클의 누적 매도 수익

**다음 사이클 원금 결정**:
```
수동 모드: config.tickerConfigs[ticker].principal (사용자 설정값 사용)
자동 모드: principalCalculator가 계산한 값 사용
  - nextPrincipal = cycleData.principal + cycleData.totalRealizedProfit
  - 추가입금이 있으면 균등 배분 후 반영
```

**금지 사항**: 백엔드 매매 로직에서 `config.tickerConfigs[ticker].principal`을 절대 쓰지(write) 않는다.

---

## 9. 주문 흐름

### 9.1 매매 판단 흐름 (`processAccountTrading`)
```
1. 현재 상태 로드 (사이클 데이터, 설정)
2. KIS API로 현재가, 잔고 조회
3. 사이클 상태 점검:
   - 새 사이클 필요 시 → Firestore에 직접 초기화 (주문 계산 전)
   - stopAfterCycleEnd === true이면 → 해당 종목 건너뜀
4. T값 계산: T = 누적투자액 / 1회매수금
5. 별% 계산: 별% = 목표수익률 - (T × 감소율)
6. Phase 판단 (전반전/후반전/쿼터모드)
7. 매수 주문 생성 (Phase에 따라)
8. 매도 주문 생성 (별%LOC + 목표가 LIMIT)
9. 쿼터모드 진입 시 → pending 상태 저장 (isActive: false)
10. 주문 제출 또는 승인 대기
```

### 9.2 텔레그램 승인 흐름
```
1. 조건 충족 시 대기 주문 생성
2. 텔레그램 알림 전송 (승인/거부 버튼)
3. 사용자 응답:
   - 승인 → KIS API로 주문 실행
   - 거부 → 주문 취소
4. 결과 알림 (주문 제출 결과만)
※ 사이클 데이터 업데이트는 장 마감 트리거에서 체결 확인 후 수행
```

### 9.3 자동 매매 흐름
```
1. approvalMode === 'auto' 확인
2. 주문 생성 즉시 KIS API로 실행
3. 실행 결과 텔레그램 알림 (주문 제출 결과만)
※ 사이클 데이터 업데이트는 장 마감 트리거에서 체결 확인 후 수행
```

### 9.4 장 마감 트리거 (`marketCloseTrigger`)

장 마감 시점(UTC 21:00, EST 16:00)에 실행되며, **실제 체결 결과에 기반한 모든 사이클 상태 업데이트를 담당**한다.

> **핵심 원칙**: 주문 제출 시점에는 LOC/LIMIT 주문의 체결 여부를 알 수 없다. 따라서 수익 계산, 보유수량 동기화, 쿼터모드 전환, 사이클 완료 감지 등 **체결 결과에 의존하는 모든 작업은 장 마감 트리거에서만 수행**한다.

```
1. marketCloseTrigger 실행 (UTC 21:00, EST 16:00 장 마감)
2. 계좌 전략 확인 (accountStrategy)
   - 'vr' → VR 동기화 수행 (vrState 업데이트)
   - 'unlimited'(기본) → 아래 무한매수법 처리 수행
3. KIS API로 실제 잔고 + 당일 체결 내역 조회
4. 종목별 처리:
   a. 보유 데이터 확인 (holdingData)
      - holdingData가 없으면 (API 미반환) → 해당 종목 건너뜀 (안전장치)
   b. 수익 계산 (체결 기반)
      - 당일 매수 체결금액, 매도 체결금액 집계
      - totalBuyAmount, totalSellAmount 누적
      - totalRealizedProfit = totalSellAmount - totalBuyAmount
   c. 쿼터모드 상태 전환 (체결 기반)
      - MOC 매도 체결 확인 → 쿼터모드 활성화 (isActive: true)
      - 쿼터 LOC 매도 체결 + 보유수량 0 → 쿼터모드 종료, 후반전 진입
      - 쿼터 매수 체결 → round 증가
   d. 사이클 데이터 동기화
      - totalQuantity, avgPrice, totalInvested, remainingCash
      - totalBuyAmount, totalSellAmount, totalRealizedProfit
   e. 사이클 완료 감지
      - active 사이클 + totalQuantity === 0 + totalInvested > 0
      - → cycleHistory 아카이브 + 완료 처리 + 텔레그램 알림
```

> **안전장치**: KIS API에서 해당 종목의 holdingData를 반환하지 않은 경우(거래소 조회 실패, API 오류 등) "보유수량 0"으로 오판하지 않고 해당 종목을 건너뛴다. 또한 쿼터모드 종료(totalQuantity=0)를 사이클 완료 감지보다 먼저 처리하여 오인을 방지한다.

### 9.4.1 주문 제출과 상태 관리의 분리

| 시점 | 담당 함수 | 수행 작업 |
|------|----------|----------|
| 장 개시 | `processAccountTrading` | 새 사이클 초기화 (Firestore 직접 저장), 쿼터모드 pending 저장, 주문 계산 및 생성 |
| 주문 승인 | `executeApprovedOrder` | KIS API 주문 제출 + 실행 기록만 (사이클 상태 변경 없음) |
| 장 마감 | `marketCloseTrigger` | 체결 확인 → 수익 계산, 사이클 동기화, 쿼터모드 전환, 완료 감지 |

**금지 사항**: `executeApprovedOrder`에서 사이클 데이터(`cycles/{ticker}`)를 수정하지 않는다. 주문 제출은 주문 제출만 수행하고, 체결 결과에 따른 상태 변경은 반드시 `marketCloseTrigger`에서 수행한다.

### 9.5 stopAfterCycleEnd (사이클 종료 후 재시작 방지)
- **설정 위치**: `config.tickerConfigs[ticker].stopAfterCycleEnd` (종목별)
- **동작**: 현재 사이클의 매매는 정상 진행하되, 사이클이 자연 종료되면 다음 사이클을 시작하지 않음
- **주의**: 보유 수량을 강제 매도하는 기능이 아님. 일반 매매를 통해 자연스럽게 전량 매도될 때까지 대기

---

## 10. 매일 실행 프로세스

```typescript
async function dailyTradingProcess() {
  // 1. 현재 상태 로드
  const state = await loadCycleState();

  // 2. T값 계산
  const T = Math.ceil((state.totalInvested / state.buyPerRound) * 100) / 100;

  // 3. 별% 계산
  const 별퍼센트 = calculateStarPercent(state.ticker, state.strategyVersion, T, state.splitCount);

  // 4. 모드 결정
  const mode = determineMode(T, state.splitCount, state.strategyVersion);

  // 5. 매도 주문 생성 (먼저 실행)
  const sellOrders = generateSellOrders(state, T, 별퍼센트, mode);

  // 6. 매수 주문 생성
  // "쿼터매도하는 그 날은, 매수시도는 없습니다"
  let buyOrders = [];
  const hasMOCSellToday = sellOrders.some(order =>
    order.type === 'MOC' && order.skip_buy_today === true
  );

  if (!hasMOCSellToday) {
    buyOrders = generateBuyOrders(state, T, 별퍼센트, mode);
  }

  // 7. 주문 제출
  await submitOrders([...sellOrders, ...buyOrders]);

  // 8. 상태 저장
  await saveCycleState(state);
}
```

---

## 11. 별% 계산 로직

```typescript
function calculateStarPercent(
  ticker: 'TQQQ' | 'SOXL',
  version: 'v2.2' | 'v3.0',
  T: number,
  splitCount: number
): number {
  if (version === 'v3.0') {
    if (ticker === 'TQQQ') {
      return 15 - 1.5 * T;  // 15% - 1.5%T
    } else { // SOXL
      return 20 - 2.0 * T;  // 20% - 2%T
    }
  } else { // v2.2
    // 기본 공식: 10 - T/2 × (40/a)
    return 10 - (T / 2) * (40 / splitCount);
  }
}
```

---

## 12. 1회매수금 업데이트 (V3.0 반복리)

```typescript
function update1회매수금(state: CycleState, 사이클수익: number) {
  if (사이클수익 > 0) {
    // 수익의 50%를 1회매수금에 즉시 반영
    state.buyPerRound += 사이클수익 / 40;

    // 나머지 50%는 보관
    state.reservedProfit += 사이클수익 / 2;

    // 최대치 갱신
    if (사이클수익 > state.maxProfit) {
      state.maxProfit = 사이클수익;
    }
  } else {
    // 손실 시: 1회매수금 유지
    // (과거 수익 최대치 기준으로 계산된 값 유지)

    // 자금 부족 시 보관수익금에서 충당
    if (state.remainingCash < state.buyPerRound) {
      const 부족금 = state.buyPerRound - state.remainingCash;
      if (state.reservedProfit >= 부족금) {
        state.reservedProfit -= 부족금;
        state.remainingCash += 부족금;
      }
    }
  }
}
```

---

## 13. 구현 현황

### 13.1 완료된 기능
- ✅ V2.2 / V3.0 별% 계산
- ✅ 전반전 / 후반전 매수 로직
- ✅ 쿼터매도 (별%LOC + 목표가LIMIT)
- ✅ LOC / MOC / LIMIT 주문 제출
- ✅ 텔레그램 승인 알림
- ✅ 자동 매매 모드
- ✅ 다중 종목 지원
- ✅ 투자원금 계산 및 배분
- ✅ 사이클 자연 완료 감지 (장 마감 시 보유수량 0 → completed 전환)
- ✅ 종목별 stopAfterCycleEnd (사이클 종료 후 재시작 방지)
- ✅ 주문 제출과 사이클 상태 관리 분리 (체결 기반 동기화)
- ✅ 체결 기반 수익 계산 (totalBuyAmount, totalSellAmount → totalRealizedProfit)

### 13.2 구현 예정
- ⬜ V3.0 반복리 자동 적용
- ⬜ V2.2 쿼터손절 모드 완전 구현
- ⬜ 하방 추가 매수 (급락 대비)

---

## 14. 주의사항

### 14.1 가격 계산 정밀도
- 소수점 처리에 주의 (특히 T값 계산 시 올림)
- 가격은 최소 $0.01 단위

### 14.2 주문 충돌 방지
- 매수와 매도가 같은 가격에 걸리지 않도록
- 매수점에서 -$0.01 조정

### 14.3 상태 동기화
- 사이클 상태(보유수량, 평단가, 수익 등)는 장 마감 트리거에서만 동기화
- 주문 제출 시점에는 사이클 데이터를 변경하지 않음
- 새 사이클 초기화는 주문 계산 전에 `processAccountTrading`에서 수행

### 14.4 에러 처리
- API 실패 시 재시도 로직 (최대 3회)
- 자금 부족 시 알림
- 주문 체결 실패 시 로깅

---

## 15. 참고 자료

### 15.1 원본 자료
- **V2.2 방법론**: mmb2.2.pdf (라오어, 2023년 5월)
- **V3.0 방법론**: mmb3.0.pdf (라오어, 2024년 6월 13일)
- **SPECIFICATION.md**: 시스템 구현 스펙 문서

### 15.2 위험 고지
- 레버리지 ETF 특성상 급격한 변동에 취약
- 닷컴버블, 리먼사태 같은 대규모 하락장에서 큰 손실 가능
- 규칙을 반드시 지켜야 함 (감정 배제)
- 초보자는 40분할로 최소 6개월 이상 경험 후 20분할 고려

---

**문서 작성일**: 2026-02-07
**최종 수정일**: 2026-02-13
**작성자**: Claude (Based on 라오어's methodology)
