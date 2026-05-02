# VR(밸류 리밸런싱) 매매법 구현 문서

## 1. VR 매매법 개요

### 1.1 핵심 개념
VR(Value Rebalancing)은 목표 평가금(V)을 중심으로 밴드를 설정하고, 평가금이 밴드를 이탈할 때 매매하는 전략입니다.

### 1.2 핵심 공식
```
V 업데이트 공식 (2가지 중 선택):
  기본공식: V₂ = V₁ + Pool/G ± (적립금 or 인출금)
  실력공식: V₂ = V₁ + Pool/G + (E - V₁)/(2√G) ± (적립금 or 인출금)
            E = 마지막 평가금 (보유수량 × 현재가)

최소밴드 = V × (1 - bandPercent)  // 기본: V × 0.85
최대밴드 = V × (1 + bandPercent)  // 기본: V × 1.15

매수조건: 평가금 < 최소밴드
매도조건: 평가금 > 최대밴드

매수점 = VR_MIN / (현재수량 + 매수수량)
매도점 = VR_MAX / (현재수량 - 매도수량)
```

### 1.2.1 실력공식 상세
실력공식의 핵심은 `(E - V₁)/(2√G)` 항으로, 시장 상황에 따라 V값 증가 속도를 자동 조절합니다:
- **E > V₁** (시장 상승): 양수 → V가 빠르게 증가
- **E < V₁** (시장 하락): 음수 → V 증가가 느려지거나 감소
- **E = V₁**: 0 → 기본공식과 동일

**검증 예시 (62주차):**
```
E=5282.11, V₁=15205.76, Pool=76.73, G=11, 적립금=250
V₂ = 15205.76 + 76.73/11 + (5282.11-15205.76)/(2√11) + 250
   = 15205.76 + 6.98 + (-9923.65)/6.633 + 250
   = 15205.76 + 6.98 - 1496.05 + 250
   = 13966.69
```

### 1.3 Pool 정의
**Pool = 해외주문가능금액 (외화잔고, USD)**

**KIS API 조회 방식:**
```typescript
// getBuyableAmount API 호출
const buyableData = await kisClient.getBuyableAmount(...);
accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || '0');
```

| 필드명 | 설명 |
|--------|------|
| `ovrs_ord_psbl_amt` | **해외주문가능금액** (USD) ← Pool로 사용 |
| `ord_psbl_frcr_amt` | 주문가능외화금액 |
| `frcr_ord_psbl_amt1` | 외화주문가능금액1 (통합) |

**중요:**
- ✅ **USD 외화잔고만** Pool로 사용
- ❌ **원화(KRW) 예수금**은 Pool에 포함되지 않음
- 원화 입금 후 환전해야 Pool에 반영됨
- 매수하면 예수금 감소 → Pool 감소
- 매도하면 예수금 증가 → Pool 증가
- 사이클 종료 시점의 예수금이 V 계산에 사용됨

### 1.4 Pool 사용 한도
투자 모드별 초기 한도 (26주마다 5%씩 감소, 최소 10%):
- **적립식(accumulate)**: 75%
- **거치식(lump)**: 50%
- **인출식(withdraw)**: 25%

### 1.5 사이클
- 2주마다 V값 재계산
- 기본공식: V₂ = V₁ + Pool/G ± 적립금
- 실력공식: V₂ = V₁ + Pool/G + (E-V₁)/(2√G) ± 적립금
- 공식 변경은 VRConfig에 저장, 다음 사이클(V 업데이트)부터 vrState에 반영

---

## 2. 원본 VR vs 구현된 VR

### 2.1 원본 VR 방식
- **2주간 기간 잔량 지정가 예약매수/매도**
- 여러 가격대에 미리 주문을 걸어두고 2주간 유지
- 예시:
  - 매수: 91주→$48.99, 92주→$48.45, 93주→$47.92...
  - 매도: 89주→$66.28, 88주→$67.03, 87주→$67.80...

### 2.2 KIS API 제약사항
```
예약주문 유효기간: 당일
- 미국장 마감 후, 미체결주문은 자동취소
- 2주간 유지 불가
```

### 2.3 선택된 구현 방식: 매일 예약주문 재제출
- 매일 장 시작 전에 VR 계산 기반으로 예약주문 접수
- 미체결 시 익일 다시 제출
- 2주간 V값은 고정 유지

---

## 3. 구현된 파일 및 역할

### 3.1 백엔드 (idca-functions)

#### `src/lib/vrCalculator.ts` (신규 생성)
VR 계산 로직 전담 모듈

**주요 타입:**
```typescript
type VRInvestmentMode = 'accumulate' | 'lump' | 'withdraw';
type VRFormulaType = 'basic' | 'skill';

interface VRCalculateParams {
  ticker: string;
  currentPrice: number;
  totalQuantity: number;
  targetValue: number;        // V (목표 평가금)
  pool: number;               // Pool (계좌 예수금)
  gradient: number;           // G (기울기: 10 또는 20)
  bandPercent: number;        // 밴드 퍼센트 (0.15)
  investmentMode: VRInvestmentMode;
  periodicAmount: number;     // 적립금/인출금
  cycleNumber: number;
  lastVUpdateDate: Date;
  weekNumber: number;
}

interface VRCalculateResult {
  currentEvaluation: number;
  targetValue: number;
  minBand: number;
  maxBand: number;
  action: 'buy' | 'sell' | 'hold';
  actionReason: string;
  buyOrders: VROrder[];
  sellOrders: VROrder[];
  analysis: { ... };
  nextVUpdate: { ... };
}
```

**주요 함수:**
- `calculateVR(params)`: 메인 계산 함수 (단일 주문)
- `calculateVRMultiPrice(params)`: 다중 가격대 주문 계산 (매일 예약주문용)
- `generateMultiPriceBuyOrders(...)`: 여러 가격대 매수 주문 생성
- `generateMultiPriceSellOrders(...)`: 여러 가격대 매도 주문 생성
- `calculateBands(targetValue, bandPercent)`: 밴드 계산
- `calculateNewTargetValue(...)`: V값 업데이트 계산 (기본공식/실력공식 지원)
- `calculatePoolUsageLimit(mode, weekNumber)`: Pool 사용 한도
- `calculateBuyPrice(minBand, currentQty, buyQty)`: 매수점 계산
- `calculateSellPrice(maxBand, currentQty, sellQty)`: 매도점 계산
- `checkVUpdateNeeded(lastVUpdateDate)`: V 업데이트 필요 여부
- `createInitialVRState(...)`: VR 초기 상태 생성
- `adjustOrdersForCurrentPrice(...)`: 현재가 기반 주문 조정 (이탈 주문 통합)

#### `src/lib/kisApi.ts` (예약주문 API 추가)
VR 예약주문 API 연동

**추가된 타입:**
```typescript
interface ReservationOrderResponse { ... }
interface ReservationOrderListResponse { ... }
interface ReservationCancelResponse { ... }
```

**추가된 메서드:**
- `submitReservationOrder(...)`: 예약주문 접수 (TTTT3014U/TTTT3016U)
- `getReservationOrders(...)`: 예약주문 목록 조회 (TTTT3039R)
- `cancelReservationOrder(...)`: 예약주문 취소 (TTTT3017U)

#### `src/index.ts` (최소 수정)
**원칙**: 기존 무한매수법 로직 절대 수정 안 함

**추가된 부분 (3줄):**
```typescript
// processAccountTrading 함수 시작 부분
const accountStrategy = config.accountStrategy || 'infinite';
if (accountStrategy === 'vr') {
  return processVRTrading(userId, accountId, config, db, options);
}
```

**신규 함수:**
- `processVRTrading()`: VR 매매 처리 (완전 독립)
- VR 상태 조회/초기화
- VR 계산 실행
- 주문 생성 및 텔레그램 알림

**executeApprovedOrder 수정:**
- VR/무한매수법 모두 일반주문 API 사용 (`submitOrder`)
- MOO/LOO/LIMIT 등 주문 유형은 orderType으로 구분
- VR 주문 실행 후 vrState 업데이트

#### `src/lib/telegram.ts` (함수 추가만)
**기존 함수 수정 없음**, 새 함수만 추가

**신규 함수:**
- `notifyVROrderPendingWithId()`: VR 주문 승인 요청 메시지
- `notifyVRAutoOrder()`: VR 자동 주문 알림

---

### 3.2 프론트엔드 (idca-web)

#### `src/lib/firestore.ts` (타입 및 서비스 함수 추가)

**추가된 타입:**
```typescript
type AccountStrategy = 'infinite' | 'vr';
type VRInvestmentMode = 'accumulate' | 'lump' | 'withdraw';
type VRFormulaType = 'basic' | 'skill';

interface VRConfig {
  enabled: boolean;
  ticker: 'TQQQ';
  investmentMode: VRInvestmentMode;
  periodicAmount: number;
  gradient: number;
  bandPercent: number;
  formulaType?: VRFormulaType;   // V 업데이트 공식 (기본: 'basic')
  updatedAt: Timestamp;
}

interface VRStateData {
  ticker: string;
  status: 'active' | 'paused';
  targetValue: number;
  pool: number;
  gradient: number;
  bandPercent: number;
  cycleNumber: number;
  cycleStartDate: Timestamp;
  lastVUpdateDate: Timestamp;
  periodicAmount: number;
  investmentMode: VRInvestmentMode;
  formulaType?: VRFormulaType;   // 현재 사이클 적용 공식
  minBand: number;
  maxBand: number;
  poolUsageLimit: number;
  initialInvestment: number;
  totalRealizedProfit: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

**UserTradingConfig 수정:**
```typescript
interface UserTradingConfig {
  // ... 기존 필드들 ...
  accountStrategy?: AccountStrategy;  // 기본값: 'infinite'
}
```

**추가된 서비스 함수:**
- `getVRConfig(userId, accountId)`: VR 설정 조회
- `saveVRConfig(userId, accountId, config)`: VR 설정 저장
- `getVRState(userId, accountId, ticker)`: VR 상태 조회
- `saveVRState(userId, accountId, ticker, state)`: VR 상태 저장
- `getAccountStrategy(userId, accountId)`: 계좌 전략 조회
- `setAccountStrategy(userId, accountId, strategy)`: 계좌 전략 설정
- `getDefaultVRConfig()`: 기본 VR 설정

#### `src/app/settings/page.tsx` (UI 추가)
- 전략 선택 라디오 버튼 (무한매수법/VR)
- 진행 중 사이클 있으면 변경 불가 경고
- VR 설정 폼:
  - 투자 모드 (적립식/거치식/인출식)
  - 기울기(G) 입력
  - 밴드(%) 입력
  - V 업데이트 공식 (기본공식/실력공식)
  - 적립금/인출금 입력

#### `src/app/page.tsx` (대시보드 VR 상태 표시)
- VR 계좌일 경우 VR 진행 상황 섹션
- 밴드 시각화 (현재 평가금 위치)
- V값, 최소/최대밴드, Pool 표시
- 다음 V 업데이트까지 남은 일수

---

## 4. Firestore 스키마

### 4.1 VR 설정
**경로**: `users/{userId}/accounts/{accountId}/config/vr`
```typescript
{
  enabled: boolean,
  ticker: 'TQQQ',
  investmentMode: 'accumulate' | 'lump' | 'withdraw',
  periodicAmount: number,
  gradient: number,         // 기본: 10
  bandPercent: number,      // 기본: 0.15
  formulaType?: 'basic' | 'skill',  // V 업데이트 공식 (기본: 'basic')
  updatedAt: Timestamp
}
```

### 4.2 VR 상태
**경로**: `users/{userId}/accounts/{accountId}/vrState/{ticker}`
```typescript
{
  ticker: string,
  status: 'active' | 'paused',
  targetValue: number,
  pool: number,
  gradient: number,
  bandPercent: number,
  cycleNumber: number,
  cycleStartDate: Timestamp,
  lastVUpdateDate: Timestamp,
  periodicAmount: number,
  investmentMode: string,
  formulaType?: 'basic' | 'skill',  // 현재 사이클 적용 공식
  minBand: number,
  maxBand: number,
  poolUsageLimit: number,
  initialInvestment: number,
  totalRealizedProfit: number,
  createdAt: Timestamp,
  updatedAt: Timestamp,

  // 장 마감 동기화 필드 (marketCloseTrigger에서 업데이트)
  lastQuantity?: number,       // 마지막 동기화 보유수량
  lastAvgPrice?: number,       // 마지막 동기화 평단가
  lastEvaluation?: number,     // 마지막 동기화 평가금 (수량 × 현재가)
  syncedAt?: Timestamp,        // 마지막 동기화 시각
}
```

### 4.3 UserTradingConfig 확장
**경로**: `users/{userId}/accounts/{accountId}/config/trading`
```typescript
{
  // ... 기존 필드 ...
  accountStrategy?: 'infinite' | 'vr'  // 기본값: 'infinite'
}
```

---

## 5. 주문 흐름

### 5.1 VR 매매 판단 흐름
```
1. 현재 평가금 계산: 보유수량 × 현재가
2. 밴드 계산: minBand = V × 0.85, maxBand = V × 1.15
3. 판단:
   - 평가금 < minBand → 매수 필요
   - 평가금 > maxBand → 매도 필요
   - 그 외 → 홀드
4. 주문 수량 계산 (Pool 한도 고려)
5. 주문가 계산 (매수점/매도점 공식)
```

### 5.2 텔레그램 승인 흐름
```
1. VR 조건 충족 시 대기 주문 생성 (다중 가격대)
2. 텔레그램 알림 전송 (승인/거부 버튼)
3. 사용자 응답:
   - 승인 → KIS 예약주문 API로 주문 실행
   - 거부 → 주문 취소
4. 결과 알림
5. 예약주문은 당일만 유효 (미체결 시 자동 취소)
```

### 5.3 VR 예약주문 특성
- VR 주문 승인 시 `submitReservationOrder()` 사용 (일반 주문 아님)
- 예약주문은 장 시작 전에 접수되어 당일 유효
- 장 마감 시 미체결 주문은 KIS에서 자동 취소
- 다음 processVRTrading 실행 시 새로운 가격 기준으로 재계산

### 5.4 장 마감 동기화 (marketCloseTrigger)
```
1. marketCloseTrigger 실행 (UTC 21:00, EST 16:00)
2. 계좌 전략 확인: accountStrategy === 'vr'
3. KIS API로 실제 잔고 조회
4. 종목별 holdingData 확인
   - holdingData 있으면 → vrState 동기화 (보유수량, 평단가, 평가금)
   - holdingData 없으면 → 건너뜀
5. 오늘 체결 내역으로 pendingOrders 체결 추적 (markFilledOrders)
```

> **중요**: `marketCloseTrigger`는 계좌 전략별로 분기한다. VR 계좌는 vrState 동기화만 수행하고, 무한매수법의 cycles 체크는 수행하지 않는다. 이를 통해 다중 계좌 환경에서 VR 계좌에 남아있는 잔여 cycles 데이터가 사이클 완료로 오판되는 문제를 방지한다.

---

## 6. 구현 현황

### 6.1 ~~예약주문 API~~ ✅ 완료
- `kisApi.ts`에 예약주문 API 함수 추가:
  - `submitReservationOrder()`: 예약주문 접수 (TTTT3014U/TTTT3016U)
  - `getReservationOrders()`: 예약주문 목록 조회 (TTTT3039R)
  - `cancelReservationOrder()`: 예약주문 취소 (TTTT3017U)
- VR 전략 주문 시 자동으로 예약주문 API 사용

### 6.2 ~~다중 가격대 주문~~ ✅ 완료
- `generateMultiPriceBuyOrders()`: 91주@$46.24, 92주@$45.73, ... 형태로 1주씩 분산 매수 주문
- `generateMultiPriceSellOrders()`: 89주@$63.96, 88주@$64.69, ... 형태로 1주씩 분산 매도 주문
- `calculateVRMultiPrice()`: 다중 가격대 주문 계산 메인 함수

### 6.3 ~~V값 자동 업데이트~~ ✅ 완료
- `checkVUpdateNeeded()`: 2주 경과 여부 확인
- `calculateNewTargetValue()`: 기본공식 또는 실력공식으로 V 계산
- `processVRTrading()`: V 업데이트 필요 시 Firestore에 자동 저장

### 6.6 ~~실력공식 지원~~ ✅ 완료
- `VRFormulaType = 'basic' | 'skill'` 타입 추가
- `calculateNewTargetValue()`에 `formulaType`, `currentEvaluation` 파라미터 추가
- 실력공식: `V₂ = V₁ + Pool/G + (E-V₁)/(2√G) ± 적립금`
- 설정 페이지에 공식 선택 드롭다운 추가
- VRConfig에 예약 저장 → 다음 사이클(V 업데이트) 시 vrState에 반영
- 기존 사용자(formulaType 미설정)는 기본공식으로 동작 (하위호환)

### 6.7 ~~현재가 기반 주문 조정 + 일반주문 전환~~ ✅ 완료
- 예약주문(TTTT3014U/3016U) → 일반주문(TTTT1002U/1006U) 전환 (KST 18:00 프리마켓 시간 활용)
- 가격 급변 시 주문 범위를 벗어난 주문들을 현재가에 통합
- 매도 통합: MOO(장개시시장가, ORD_DVSN='31') → 시작가에 체결
- 매수 통합: LOO(장개시지정가, ORD_DVSN='32') + 10% 버퍼 → 시작가에 체결 보장
- `adjustOrdersForCurrentPrice()`: 당일 제출용 조정 (Firestore pendingOrders 미변경)
- `submitOrder()`에 MOO/LOO 주문 유형 매핑 추가

### 6.4 ~~매도 체결 후 상태 업데이트~~ ✅ 완료
- `executeApprovedOrder()`: VR 주문 실행 후 vrState 업데이트
- Pool(예수금)은 KIS API에서 실시간 조회되므로 별도 반영 불필요
- 실현 수익 추정치 기록 (totalRealizedProfit)

### 6.5 ~~VR 초기 진입~~ ✅ 완료
- 보유 주식 0주 + 예수금 있을 때 자동 초기 진입 주문 생성
- Pool 사용 한도 적용 (적립식 75%, 거치식 50%, 인출식 25%)
- 체결 후 평가금을 V로 설정하여 vrState 자동 생성

### 6.8 ~~장 마감 VR 상태 동기화~~ ✅ 완료
- `marketCloseTrigger`에서 VR 계좌 전략 분기 처리
- KIS API 실제 잔고 기반 vrState 동기화 (`lastQuantity`, `lastAvgPrice`, `lastEvaluation`, `syncedAt`)
- VR 계좌에서 무한매수법 cycles 체크를 수행하지 않도록 격리
- 체결 내역 기반 pendingOrders 추적 (`markFilledOrders`)

### 6.9 ~~VR 사이클 히스토리 저장~~ ✅ 완료
- V 업데이트(2주마다) 시점에 이전 사이클 스냅샷을 `users/{userId}/cycleHistory`에 저장
- 저장 항목: V값, 평가금, Pool, 보유수량, 평단가, 밴드, G, 공식타입, 투자모드, 실현수익
- `CycleHistoryData` 타입에 VR 전용 필드 추가 (`targetValue`, `evaluation`, `pool`, `quantity`, `avgPrice`, `gradient`, `bandPercent`, `investmentMode`, `formulaType`, `periodicAmount`, `minBand`, `maxBand`)
- 사이클 히스토리 페이지(`/history/cycles`)에서 VR 전략 필터로 조회 가능
- VR 카드: V값/평가금/Pool 표시 + G/밴드/공식/모드/보유수량/밴드범위

---

## 7. 사용자 설정 사항

- **초기 V값**: 매입금액(원금) 사용 (보유 수량 × 평단가). 기존 미실현 수익/손실이 밴드에 반영됨
- **Pool 관리**: 계좌 예수금 자동 사용
- **지원 종목**: TQQQ만 (단일 종목)
- **전략 변경 조건**: 진행 중인 사이클 없어야 함

### 7.1 VR 초기화 (보유 주식이 있는 경우)
이미 주식을 보유한 상태에서 VR을 시작하면 첫 매매 트리거 시 자동 초기화:

```
1. KIS API로 보유수량, 평단가, 현재가, 예수금 조회
2. V = 매입금액 (보유수량 × 평단가) ← 원금 기준
3. 밴드 계산: minBand = V × 0.85, maxBand = V × 1.15
4. 잔량주문(pendingOrders) 초기화
5. vrState Firestore에 저장
```

**예시:**
- 35주 보유, 평단가: $47.64, 현재가: $50.06
- V = 35 × $47.64 = **$1,667.40** (매입금액)
- minBand = $1,417.29, maxBand = $1,917.51
- 현재 평가금 = 35 × $50.06 = $1,752.10 → V보다 5% 위 (기존 수익 반영)

> **V를 현재 평가금이 아닌 매입금액으로 설정하는 이유**: 기존 미실현 수익/손실이 밴드에 반영되어, 이미 오른 종목은 매도 방향, 손실 중인 종목은 매수 방향으로 VR이 동작합니다.

### 7.2 VR 초기 진입 (보유 주식 0주)
주식이 없고 예수금만 있는 경우 자동으로 초기 진입 주문 생성:

```
1. 예수금 확인 (예: $500)
2. Pool 사용 한도 적용 (적립식 75%, 거치식 50%, 인출식 25%)
3. 현재가 기준 매수 가능 수량 계산
4. 초기 진입 주문 생성 (승인 대기 또는 자동 실행)
5. 체결 후 평가금을 V로 설정하여 vrState 생성
```

**예시:**
- 예수금: $500, 현재가: $50, 모드: 적립식
- 사용 가능: $500 × 75% = $375
- 매수 수량: floor($375 / $50) = 7주
- 초기 진입: 7주 × $50 = $350
- 체결 후 V = $350, minBand = $297.50, maxBand = $402.50

---

## 8. 관련 KIS API

### 8.1 예약주문 접수 ✅ 구현됨
- **함수**: `kisClient.submitReservationOrder()`
- **TR_ID**: TTTT3014U (미국예약매수), TTTT3016U (미국예약매도)
- **URL**: `/uapi/overseas-stock/v1/trading/order-resv`
- **제약**: 당일만 유효, 장 마감 시 자동취소
- **참고**: 실전투자만 지원 (모의투자 미지원)

### 8.2 예약주문 조회 ✅ 구현됨
- **함수**: `kisClient.getReservationOrders()`
- **TR_ID**: TTTT3039R (미국)
- **URL**: `/uapi/overseas-stock/v1/trading/order-resv-list`

### 8.3 예약주문 취소 ✅ 구현됨
- **함수**: `kisClient.cancelReservationOrder()`
- **TR_ID**: TTTT3017U
- **URL**: `/uapi/overseas-stock/v1/trading/order-resv-ccnl`

---

## 9. 기존 무한매수법 영향도

### 9.1 변경된 부분
- `processAccountTrading()` 시작 부분에 3줄 추가 (VR 분기)

### 9.2 영향 없음 보장
- `accountStrategy`가 없거나 'infinite'면 기존 로직 100% 동일
- VR 코드는 완전히 별도 함수로 분리
- 기존 타입, 함수 수정 없음 (추가만)

---

## 10. 백테스트 결과

### 10.1 TQQQ 2022-2025 백테스트 (적립식 $500/월)

**조건:**
- 초기 자금: $500
- 월 적립금: $500
- 기울기(G): 10
- 밴드: ±15%
- 총 입금액: $18,500

**VR 매매법 결과:**
| 항목 | 값 |
|------|------|
| 최종 포트폴리오 | $23,498 |
| 총 수익률 | +27.02% |
| 순이익 | +$4,998 |
| 총 거래 | 510건 (매수 89건, 매도 421건) |
| 실현 수익 | $8,835 |

**단순 적립식(DCA) 비교:**
| 전략 | 총 입금액 | 최종 가치 | 수익률 | 순이익 |
|------|----------|----------|--------|--------|
| VR 매매법 | $18,500 | $23,498 | +27.02% | +$4,998 |
| 단순 적립식 | $18,500 | $21,744 | +17.53% | +$3,244 |

**VR vs DCA:**
- 수익률 차이: **+9.49%p**
- 순이익 차이: **+$1,754**

### 10.2 백테스트 스크립트
- 경로: `backtest/vr_backtest.py`
- 실행: `python vr_backtest.py` (2025년) 또는 `python vr_backtest.py 2022` (2022-2025년)
- 검증 스크립트: `backtest/vr_debug.py` (Pool/V 업데이트 검증)
