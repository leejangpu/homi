# 떨사오팔 (ddsaopal)

**떨**어지면 **사**고 **오**르면 **팔**다. 토스증권 OpenAPI 기반 자동매매.

> 전략 권위 사양: **[SPEC.md](./SPEC.md)** — 코드는 이 문서를 포팅한 것. 충돌 시 SPEC 우선.

## 한눈에

- 예수금을 n분할(기본 7). 전일 종가보다 떨어진 날에만 1분할 LOC 매수.
- 각 매수 로트("떨")는 매수가 +0.3%에 LOC 매도. 매수 후 12영업일 지나면 종가매도(손절).
- 보유 로트가 0이 되면 사이클 종료 → 남은 예수금으로 재분할·재시작.
- 토스는 MOC 미지원 → 손절 종가매도는 **저가 LOC**로 구현.

## 구조

| 파일 | 역할 |
|---|---|
| `SPEC.md` | 전략 확정 사양(권위) |
| `config.json` | 종목/분할수/이익률/손절일/가드 |
| `src/types.ts` | 상태·주문·설정 타입 |
| `src/calculator.ts` | **순수 코어** — 틱반올림·splitAmount·다음날 계획·체결 반영·사이클 리셋 |
| `src/test.ts` | 손계산 시나리오 검증 (I/O 없음) |
| `src/tossApi.ts` | 토스 LOC 주문/보유/매수가능금액/캘린더 (IPv4 강제) |
| `src/main-close.ts` / `src/main-open.ts` | 마감 반영·다음날 계획 / 개장 주문 제출 |
| `src/probe.ts` | 읽기전용 스모크(토큰/캔들/매수가능/보유) |
| `open.sh` / `close.sh` + `launchd/*.plist` | 집 맥 launchd 스케줄 (open KST 04:00, close KST 07:00, 화~토) |

## 실행

```bash
cd ddsaopal && npm install
npm test                    # 코어 로직 시나리오 검증 (I/O 없음)
npx tsx src/probe.ts        # 토스 읽기전용 연결 확인
npx tsx src/main-close.ts   # 마감 반영 + 다음날 계획 (주문 없음, 상태/알림 O)
npx tsx src/main-open.ts    # 개장 주문 제출 (기본 DRY-RUN)
```

`.env` 는 별도로 안 만들어도 `../infinite-buy/.env` 의 `TOSS_API_KEY/TOSS_SECRET_KEY/TELEGRAM_*` 를 자동 사용.

### 실주문 활성화 (3중 가드, SPEC §11)

1. `config.json` 의 `"enabled": true`
2. `open.sh` 의 `export DDSAOPAL_LIVE_ORDERS=YES_REALLY` 주석 해제
3. (기본 DRY-RUN — 위 둘 없으면 주문 미제출, 계획만 로그/알림)

### launchd 등록

```bash
cp launchd/com.homi.ddsaopal-open.plist  ~/Library/LaunchAgents/
cp launchd/com.homi.ddsaopal-close.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.homi.ddsaopal-open.plist
launchctl load ~/Library/LaunchAgents/com.homi.ddsaopal-close.plist
```
