# VR 계산기 (밸류 리밸런싱 / Value Rebalancing)

> 라오어 **밸류 리밸런싱(VR)** 전략 보조 계산기. 가계부 웹(`financial/index.html`) 안의 한 탭(⚖️ "VR 계산기").
> **주의: "VR"은 vacation(휴가)이 아니라 이 투자 전략**을 뜻한다. CLAUDE.md 스케줄러 맵의 옛 "VR(휴가) 리마인더" 표기는 오류이며, 실제는 이 리밸런싱을 상기시키는 미리알림이다. 또한 무한매수법 가계부 시트의 "한국투자증권 (VR)" 계좌와도 개념이 겹칠 뿐 별개 데이터다.

## 무엇을 하나

밸류 리밸런싱은 **목표 평가액(V)을 매 주기 정해두고, 실제 평가액이 V의 밴드를 벗어나면 사서/팔아서 V로 되돌리는** 전략이다. 계산기는 티커별로 상태를 관리하며:

1. 현재 평가액과 밴드(min/max)를 계산해 **매수/매도/보류** 신호를 낸다
2. 밴드 이탈 시 **정확한 지정가 주문 목록**(수량 1주 단위)을 생성한다
3. 2주 뒤 적용할 **다음 V값(newV)**을 실력공식으로 산출한다
4. 사이클을 종료(→ 히스토리)하고 다음 사이클을 시작한다

계산은 전부 클라이언트(`vrCalculate()`)에서 돌고, **파생값(computed)은 저장하지 않는다**(입력만 저장, 열 때 재계산).

## 데이터 구조

### 저장 (현행 = DB, 단일 진실원)
- **트래커**: DB `vr_tracker`(ticker PK, `data` JSON, `version`) — 티커별 활성 사이클 상태
- **히스토리**: DB `vr_history`(append) — 종료된 사이클 스냅샷
- **API**: `financial/api.js`
  - `GET /api/vr` → `{ trackers, versions }`
  - `PATCH /api/vr/:ticker` `{ data, baseVersion, password }` → 낙관적 잠금 저장, SSE `type:'vr'` 브로드캐스트
  - `DELETE /api/vr/:ticker` `{ password }` → 트래커 삭제(사이클 종료 시)
  - `GET /api/vr/history`, `POST /api/vr/history` `{ entry, password }` → 종료 사이클 append
- **낙관적 잠금**: `store.js applyVrPatch()` — `baseVersion` 불일치 시 `{ conflict:true, current, currentVersion }` 반환

### 파일 미러 (사람이 읽는 사본 + 리마인더 소비원)
- `financial/vr-state.json` — 활성 트래커 전체(ticker→상태), `financial/vr-history.json` — 종료 사이클 배열
- `gitsync.js`가 DB 변경 시 export(`afterVrChange`)하고, 외부에서 파일이 바뀌면 import(`importVrState`/`importVrHistory`, 해시 에코방지)
- **index.html 폴백**: `/api/vr` 우선, 실패 시 `./vr-state.json` 파일 폴백

### 제거된 레거시 경로
- 옛 `server/api.js`(포트 3456) `/api/vr/load`·`/api/vr/save` — DB 이전 시절 파일 기반 standalone API. 현행 가계부 웹은 쓰지 않았고 **2026-07 디렉토리째 제거**됨(기능은 `financial/`로 흡수).

## 트래커 필드

| 필드 | 의미 |
|---|---|
| `ticker` | 종목/식별자 (예: `TQQQ`, `ISA나스닥레버리지`) |
| `marketTicker` | **조회용 티커** (가격 알림용 실제 시장 심볼. US는 티커 `TQQQ`, KR은 6자리 종목코드 `409820` 등. 미입력 시 USD는 `ticker`가 티커 형태면 폴백) |
| `currentPrice` | 현재가 |
| `totalQuantity` | 현재 보유 수량 |
| `targetValue` | **현재 목표 평가액 V** (전략의 핵심 기준값) |
| `pool` | 대기 자금(Pool) |
| `gradient` | 분모/기울기(보통 10 또는 20). 클수록 완만 |
| `bandPercent` | 밴드 폭 %(예: 10, 15) |
| `periodicAmount` | 주기(2주) 입금액. `withdraw` 모드면 차감 |
| `weekNumber` | 전략 시작 후 경과 주차 |
| `strategyStartDate` / `cycleStartDate` | 전략/현재 사이클 시작일 |
| `investmentMode` | `accumulate`(적립) / `lump`(거치) / `withdraw`(인출) |
| `currency` | `USD` / `KRW` |
| `executedBuyCount` / `executedSellCount` | 이번 사이클 체결 처리한 주문 수 |
| `buyGroupSize` / `sellGroupSize` | 주문 묶음 크기(N주씩 묶어 표시/체결) |
| `cycleNumber` / `cycleStatus` | 사이클 번호 / `active`·`ended` |
| `computed` | 파생값(평가액·newV·밴드·signal). **저장 안 함, 표시용** |

## 계산 공식 (`vrCalculate`, index.html)

```
currentEvaluation = totalQuantity × currentPrice

bandRate  = bandPercent / 100
minBand   = V × (1 − bandRate)          # V = targetValue
maxBand   = V × (1 + bandRate)

# 다음 V (2주 후 적용) — 실력공식
poolContribution = pool / gradient
skillAdjustment  = (currentEvaluation − V) / (2 × √gradient)
adjustedPeriodic = (mode == withdraw) ? −|periodicAmount| : periodicAmount
newV = V + poolContribution + skillAdjustment + adjustedPeriodic

# Pool 사용 한도 (모드별 base에서 26주마다 5%p 감쇠, 최소 10%)
baseLimit  = { accumulate:0.75, lump:0.50, withdraw:0.25 }[mode]
poolLimit  = max(0.10, baseLimit − floor(weekNumber/26) × 0.05)
poolAvailable = pool × poolLimit

# 신호
signal = eval < minBand → 'buy'
       | eval > maxBand → 'sell'
       | else           → 'hold'
```

### 주문 생성
- **매수**: 예산 `poolAvailable × 0.60` 소진까지, 목표수량 `totalQuantity + n`, 주문가 = `minBand / targetQty`, 1주씩(개수 무제한, 공식 스펙 — 최대 500 안전상한)
- **매도**: 보유 수량 전체 대상, 목표수량 `totalQuantity − n`, 주문가 = `maxBand / targetQty`, 1주씩

> 값은 소수 2자리 반올림. `buyGroupSize`/`sellGroupSize`로 주문을 N주 묶음 표시/체결(`vrApplyGrouping`).

## 사이클 흐름

1. **입력/수정** → `PATCH /api/vr/:ticker`(낙관적 잠금) → SSE로 타 탭 반영
2. **신호에 따라 매수/매도** → 체결분을 `executedBuy/SellCount`로 반영
3. **다음 사이클 전환**(`vrApplyNextCycle`): `newV`를 새 V로, 주차 갱신
4. **사이클 종료**(`vrEndCycle`): 현재 상태를 `POST /api/vr/history`로 append + 트래커 `DELETE`

## 리마인더

- `scripts/vr-reminder.js` — `financial/vr-state.json`을 읽어 macOS **미리알림(Reminders)**에 리밸런싱 항목을 등록(기본 07:00). AppleScript(`osascript`)로 중복 방지 후 생성.
- 스케줄: launchd `com.homi.vr-reminder.plist` + GH Actions `vr-reminder.yml`.

## 가격 알림 (장중 매수/매도점 도달 감시)

- `scripts/vr-price-alert.js` — DB `vr_tracker`의 활성 트래커를 읽어 **토스 OpenAPI**로 현재가를 조회, **매수점/매도점(주문 목록의 지정가)에 도달**하면 **Alram🔔 텔레그램**으로 알림.
- 스케줄: launchd `com.homi.vr-price-alert.plist` — **매시 05분** 기동, 스크립트가 토스 `market-calendar/{KR,US}`로 개장 여부를 판정해 **정규장 중에만** 조회 (KRW 종목→국내장 09:00–15:30, USD 종목→미국장 KST 22:30–05:00·서머타임 자동 반영, 휴장일 자동 스킵).
- 조회 심볼: 트래커 `marketTicker`(웹 "조회용 티커" 필드). 미입력 시 USD는 `ticker` 폴백, KRW는 스킵(로그에 표기).
- **판정**: 웹 `vrCalculate`와 동일 공식으로 주문 목록을 재생성하고 `buyGroupSize`/`sellGroupSize` **묶음 기준**으로 도달 여부를 본다(묶음 지정가 = 묶음 마지막 주문 가격). **카운팅 기준선 = `max(체결 executedBuy/SellCount, 오늘 이미 알린 furthestSeq)`** — 이미 체결했거나 **같은 날 앞 메시지에서 이미 알린 지점은 제외**하고 신규 지점의 누적 수량만 센다. 여러 점을 지나쳤으면 **가장 깊은 점 가격 + 신규 누적 수량**으로 알림 (예: "₩60,182 매도점 돌파 → 총 6주 매도해주세요"). 같은 날 메시지끼리 수량이 겹치지 않으므로 **각 메시지를 그대로 주문**하면 되고, 체결 반영(executed) 갱신 타이밍 레이스에도 안전.
- **dedup**: 오늘 이미 알린 깊이(furthestSeq)는 재알림 안 함, 더 깊은 점 돌파 시 **신규분만** 알림 (`logs/vr-price-alert-state.json`).
- 체결 후: 웹 계산기에서 체크하거나, Claude에게 "체크해줘"라고 요청하면 `executedBuy/SellCount`를 갱신. Claude는 **`scripts/vr-check.js`** 로 처리한다 — `node scripts/vr-check.js`(오늘 보낸 알림 전부 체결 반영, 전 트래커), `node scripts/vr-check.js <ticker>`(특정 종목만), `node scripts/vr-check.js <ticker> buy|sell <n>`(수동), `--status`(조회만). 내부적으로 `store.applyVrPatch`(낙관적 잠금)+`gitsync.afterVrChange`로 웹/API와 동일 경로 반영. "오늘 보낸 매수/매도 전부 체결했어" 요청을 1커맨드로 처리(state 파일의 furthestSeq까지 반영).
- 로그: `logs/vr-price-alert.log`. API 키: `infinite-buy/.env` (토스 + 텔레그램, IPv4 강제).

## 관련 파일 요약

| 위치 | 역할 |
|---|---|
| `financial/index.html` (`vrCalculate` 등) | UI + 계산 로직 |
| `financial/api.js` `/api/vr*` | 현행 API(DB) |
| `financial/store.js` (`applyVrPatch`·`appendVrHistory` 등) | 데이터 접근·잠금 |
| `financial/db.js` (`vr_tracker`·`vr_history`) | 스키마 |
| `financial/gitsync.js` (`exportVr`·`importVrState`) | 파일 미러 브리지 |
| `financial/vr-state.json` / `vr-history.json` | export 사본 |
| `scripts/vr-reminder.js` | macOS 미리알림 |
