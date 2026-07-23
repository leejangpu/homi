# 떨사오팔 운영 런북 (RUNBOOK)

> 전략 규칙은 `../SPEC.md`(권위), 개요·명령어는 `../README.md`. 이 문서는 **운영/모니터링/장애대응** 실무.
> 상태: 2026-07-23 라이브 전환 완료(실주문 ON).

## 1. 매일 자동으로 무슨 일이 일어나나

집 맥 launchd가 **화~토**에 하루 2번 실행한다(미국 월~금 세션 대응).

| 스크립트 | 시각(KST) | 하는 일 |
|---|---|---|
| `open.sh` → `main-open.ts` | **04:00** | 미 세션 마감 1시간 전. 전날 마감이 세워둔 계획(LOC 매수/매도/손절)을 토스에 제출 |
| `close.sh` → `main-close.ts` | **07:00** | 미 세션 마감 후. 제출 주문 체결을 대조해 로트/사이클 갱신 → **다음 세션 계획**을 세워 저장 |

즉 **"판단은 마감 후(07:00), 제출은 개장 중(04:00)"**. 모든 주문은 종가 체결(CLS). 각 실행 후 상태를 `ddsaopal-bot` 신원으로 자체 커밋·푸시한다.

매 실행 결과는 **Alram🔔**(텔레그램)로 요약이 온다. 받은 편지함만 보면 상태 파악 가능.

## 2. 상태 어디서 보나

- **상태 파일**: `state/ddsaopal-<SYMBOL>.json` — 사이클/1분할금액/보유 떨(매수가·수량·경과일)/다음 계획. git에 커밋되므로 히스토리 추적 가능.
- **로그**: `logs/open.log`, `logs/close.log` (git 제외).
- **텔레그램**: 매 실행 요약(종가, 매수가능금액, 체결 건수, 보유 떨, 다음 계획).

빠른 조회:
```bash
cd ddsaopal
cat state/ddsaopal-TQQQ.json | python3 -m json.tool   # 현재 상태
tail -40 logs/close.log                                 # 최근 마감 실행
```

## 3. 수동 실행 (점검용)

```bash
cd ddsaopal
npx tsx src/probe.ts          # 읽기전용 연결 확인(토큰/캔들/매수가능/보유) — 안전
npx tsx src/test.ts           # 코어 로직 회귀 테스트(22종) — I/O 없음
npx tsx src/main-close.ts     # 마감 반영 수동 실행 ⚠️ 미 마감 후(KST 07시 이후)에만!
```

> ⚠️ `main-close`를 **낮(미 장 개장 전/장중)에 수동 실행 금지**. 토스 일봉 API가 아직 안 끝난 당일 형성봉(=현재가)을 줄 수 있어 기준가가 오염된다. `getLastSessionClose`가 마감시각 경과로 필터링하지만, 정상 타이밍은 KST 07:00.

## 4. 라이브 On/Off · 설정 변경

**끄기(즉시 DRY-RUN 복귀)**: `config.json`의 `"enabled": false`. → 자동 실행은 계획만 텔레그램으로 보내고 주문은 안 나감.

**실주문 3중 가드**(셋 다여야 실제 주문):
1. `config.json` `"enabled": true`
2. `open.sh`의 `export DDSAOPAL_LIVE_ORDERS=YES_REALLY` (주석 아님)
3. (그 외 기본은 DRY-RUN)

**설정 항목**(`config.json`):
| 키 | 뜻 | 기본 |
|---|---|---|
| `symbol` | 대상 US 티커 | TQQQ |
| `splits` | n분할 | 7 |
| `sellProfitRate` | 이익매도 마진 | 0.003 |
| `stopLossOpenDays` | 손절 영업일 | 12 |
| `stopSellDiscount` | 손절 저가 LOC 할인폭 | 0.30 |
| `accountSeq` | 토스 계좌 seq | 1 |

> `splits`를 바꾸면 **다음 사이클 시작(보유 떨 0 → 재분할)** 부터 반영된다(진행 중 사이클의 1분할금액은 고정).

## 5. launchd 관리

```bash
# 등록(최초 1회)
cp launchd/com.homi.ddsaopal-open.plist  ~/Library/LaunchAgents/
cp launchd/com.homi.ddsaopal-close.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.homi.ddsaopal-open.plist
launchctl load  ~/Library/LaunchAgents/com.homi.ddsaopal-close.plist

# 확인 / 해제
launchctl list | grep ddsaopal
launchctl unload ~/Library/LaunchAgents/com.homi.ddsaopal-{open,close}.plist

# 즉시 강제 실행(디버그) — kickstart
launchctl kickstart -k "gui/$(id -u)/com.homi.ddsaopal-close"
```

plist를 수정하면 반드시 unload → 복사 → load.

## 6. 장애 대응

| 증상 | 원인/조치 |
|---|---|
| `unidentified-client` 401 | 토스 등록 IP(IPv4) 이탈. 코드는 IPv4 강제(`https.Agent({family:4})`)지만 네트워크/IP 변경 시 토스 콘솔 등록 IP 확인 |
| 토큰 발급 실패 | `../infinite-buy/.env`의 `TOSS_API_KEY/TOSS_SECRET_KEY` 확인 |
| 주문 거부(주문 접수 시 4xx) | 로그의 응답 메시지 확인. 저가 손절 LOC가 **가격밴드**로 거부되면 `stopSellDiscount`를 줄인다(예: 0.30→0.15) |
| 수량불일치 경고(⚠️) | close 요약의 "상태 N vs 실보유 M". 부분체결·수동거래·외부체결 가능. `state` 파일을 실보유에 맞게 보정 후 커밋 |
| 계획이 비어 매수 안 됨 | 보유 떨이 n개(만재)면 정상(매수 억제). 아니면 매수가능금액/기준가 확인 |
| 하루 건너뜀 | 미 휴장일(캘린더 `regularOpen=false`)이면 open은 스킵이 정상 |

## 7. 미검증 항목 (실보유 후 확인)

- **손절 저가 LOC의 가격밴드 거부 여부** — 첫 실보유가 12영업일에 도달할 때 실제로 확인. 거부되면 위 6번대로 `stopSellDiscount` 조정.
- **실체결 정확성** — 첫 매수 체결일에 `state`의 로트 매수가/수량이 실보유와 일치하는지 대조.

## 8. 비상 정지

1. `config.json` `"enabled": false` → 커밋. (다음 실행부터 주문 없음)
2. 이미 나간 미체결 주문은 토스 앱에서 직접 취소.
3. 보유 포지션은 전략이 계속 관리하길 원하면 enabled 유지, 손절/정리하려면 앱에서 직접 처리 후 `state` 로트 정합.
