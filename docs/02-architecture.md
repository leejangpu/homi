# Architecture (현행)

> 최종 업데이트: 2026-07-16
> 이 문서는 현행 구조 서술본. 최상위 인덱스·명령어·스케줄러/봇 맵은 루트 `CLAUDE.md`가 단일 진실원이며, 충돌 시 CLAUDE.md 우선.

## 프로젝트 구조

```
homi/
├── financial/          # 가계부 대시보드 (로컬 Express + SQLite DB) + VR 계산기 + AI 리포트 + 삼성카드 동기화
├── lotto/              # 로또 자동구매 (Python + Playwright, 로컬 launchd)
├── infinite-buy/       # 무한매수법 자동매매 (TypeScript). v2.2/v3.0 + v4.0(src/v4/) 공존
├── signal-alert/       # 시장 신호 알림 (Python, 공포탐욕+VIX+RSI 교집합, launchd)
├── scripts/            # 시스템 헬퍼 (LAN IP 알림, VR 리마인더, 자동 커밋)
├── 가계부/              # 영수증 원본 이미지 보관
├── .github/workflows/  # GitHub Actions 워크플로우
└── docs/               # 문서 (+ 서브시스템별 docs/)
```

핵심 서브시스템은 넷: **가계부**, **무한매수법**, **로또**, **시장 신호 알림**. VR 계산기는 가계부 웹 안의 한 탭으로 동거한다.

## 1. financial/ — 가계부 대시보드 + VR 계산기

**배포**: 로컬 Express 서버 (`server.js`, **포트 3000**), LAN 내 접속 전용(외부 터널 없음). macOS launchd `com.homi.serve.plist`로 상시 기동.

**데이터 = SQLite DB (단일 진실원)**: `financial/data/homi.db` (better-sqlite3 임베디드, WAL, git 제외).

| 파일 | 역할 |
|------|------|
| `server.js` | Express 진입점(포트 3000). `/api` 마운트, gitsync 기동, 영수증 분석·리포트 트리거 |
| `db.js` | DB 연결·스키마 (테이블: budget_cell/budget_sheet/expense_month/ai_summary/vr_tracker/vr_history/ext_mirror/meta) |
| `sheet.js` | 가계부 시트 파싱·합계 재계산 로직 |
| `store.js` | 데이터 접근·낙관적 잠금(버전) |
| `api.js` | 라우터 + **SSE**(`/api/stream`) |
| `gitsync.js` | git 브리지: DB변경→export(CSV/JSON)→디바운스 commit/pull/push, 외부변경→import(해시 에코방지)→SSE |
| `index.html` | 자체 포함 SPA(ECharts + jSpreadsheet). 탭: 대시보드/소득/저축/지출/자산 + **VR 계산기** + 무한매수법 진행률 |
| `2025.csv`, `2026.csv` | DB export 사본(사람이 읽는 백업, stale 가능). **원본 아님** |
| `summary.json`, `expense_detail.json` | AI 리포트·상세지출 파일(CI·영수증이 쓰고 gitsync가 DB로 흡수) |

**저장 모델**: 시트는 **셀 단위 저장 + 버전 낙관적 잠금**. 편집은 실시간 `PATCH /api/budget/cell` → 서버가 합계 재계산 → **SSE**로 타 탭 실시간 반영.

**폐기된 경로**: 전체파일 덮어쓰기 `/save`·`/save-vr`·`/save-vr-history`는 **410**(clobber 방지). 신규는 전부 `/api/*`.

**부속 기능**: AI 리포트(`generate-report.sh` → Claude CLI sonnet → `summary.json`), 삼성카드 동기화(`sync_samsungcard.py`), 영수증 분석(`analyze-receipt.sh`, same-origin `/analyze-receipt`), **VR 계산기**(→ 아래 3항 및 `financial/docs/vr-calculator.md`).

> 설계·런북: `financial/docs/db-migration-plan.md`, DB 조회법: `CLAUDE.md` "가계부 데이터 조회" 절.
> **런타임 주의**: node는 Homebrew `node@20`. better-sqlite3는 node20 ABI 프리빌트.

## 2. infinite-buy/ — 무한매수법 자동매매

**실행**: GitHub Actions **self-hosted runner**(집 맥 — KIS API가 IP 등록 방식이라 고정 IP 필요).

두 세대가 **완전 분리되어 공존**한다:

### v2.2 / v3.0 (기존 실거래)
| 파일 | 역할 |
|------|------|
| `src/main-open.ts` | 장 오픈 LOC/LIMIT 주문 제출 |
| `src/main-close.ts` | 장 마감 체결 확인 & 사이클 동기화 |
| `src/calculator.ts` | 분할매수/매도 계산(전반전/후반전/쿼터모드) |
| `src/kisApi.ts` | 한국투자증권 OpenAPI |
| `config.json` | 종목·분할수·목표수익률(`strategyVersion`) |
| `state/` | 사이클 상태 JSON (ticker별) |

- 스케줄: `infinite-buy-open.yml`(평일 00:00 KST), `infinite-buy-close.yml`(평일 07:00 KST), `infinite-buy-toggle.yml`(수동 on/off)
- 보유종목 조회는 토스증권 OpenAPI 병행(→ 5항)

### v4.0 (라오어 언이시트 포팅, 별도 모듈 `src/v4/`)
| 파일 | 역할 |
|------|------|
| `src/v4/main-open-v4.ts` | 장 개시 다음주문 제출(게이트) |
| `src/v4/main-close-v4.ts` | 장 마감 실보유 동기화→상태/다음주문 영속 |
| `src/v4/backtest/` | yfinance 실데이터 결정론적 백테스트/비교 |
| `config-v4.json` | `enabled`, `capitalSource`, 종목별 분할/목표/큰수 |
| `state/v4-*.json` | v4 전용 상태(기존과 분리) |

- 권위 출처: 언이시트 Apps Script. 사양 `infinite-buy/V4-SPEC.md`, 런북 `infinite-buy/docs/V4-RUNBOOK.md`
- **실주문 3중 가드**: `enabled` + `V4_LIVE_ORDERS=YES_REALLY` + DRY-RUN 기본
- 스케줄: `infinite-buy-v4-{open,close}.yml`(수동 트리거, 스케줄 주석. `config-v4.json` enabled=false면 미동작)
- 기존 v2.2/v3.0과 상태파일·워크플로 완전 분리 → **기존 실거래 무영향**

## 3. VR 계산기 (밸류 리밸런싱)

가계부 웹 안의 한 탭(⚖️). 라오어 **밸류 리밸런싱(Value Rebalancing)** 전략 보조 계산기. "VR"은 vacation이 아니라 이 전략을 뜻한다.

- **UI/계산**: `financial/index.html` `vrCalculate()`(클라이언트 계산, 파생값은 저장 안 함)
- **저장(현행)**: `financial/api.js` `/api/vr*`(GET/PATCH/DELETE/history) → DB `vr_tracker`/`vr_history`, 낙관적 잠금 + SSE
- **파일 미러**: gitsync가 DB→`financial/vr-state.json`·`vr-history.json` export(사람이 읽는 사본 + 리마인더 소비원)
- **리마인더**: `scripts/vr-reminder.js`가 `vr-state.json` 읽어 macOS 미리알림 등록(리밸런싱 상기). launchd `com.homi.vr-reminder.plist` + `vr-reminder.yml`

> 공식·필드·사이클 상세: `financial/docs/vr-calculator.md`
> (참고: DB 이전 시절의 파일 기반 VR API `server/`(포트 3456)는 2026-07 제거됨 — 기능은 `financial/`로 흡수)

## 4. lotto/ — 로또 자동구매

**실행**: 로컬 macOS launchd + GH Actions.

| 파일 | 역할 |
|------|------|
| `main.py` | 메인(Playwright 브라우저 자동화) |
| `modules/` | auth, purchase, history, number_generator, telegram |
| `.env` | 로또 사이트 계정, 텔레그램 알림 |

**실행 모드**: `python main.py`(랜덤 5게임) / `--auto`(자동선택) / `--check`(당첨조회) / `--dry-run`(로그인 테스트)

**스케줄 / 재시도**:
- `com.homi.lotto-purchase.plist` — **매일 10:00 KST**(구매 여부는 `main.py`가 판단)
- `com.homi.lotto-check.plist` — 매주 토요일 22:00 KST
- 게이트: 일요일 스킵, 목표 회차가 이미 `history.json`에 있으면 스킵(**구매 성공 시 재시도 안 함**)
- **예치금 부족 등 실패 시** history 미저장 + 텔레그램 알림 → **다음날 같은 시간 자동 재시도**(그 주 추첨 전까지 반복). history 존재 = 재시도 불필요의 단일 기준

## 5. signal-alert/ — 시장 신호 알림

**실행**: 로컬 macOS launchd(`com.homi.signal-alert.plist`, 매일 KST 08:00).

| 파일 | 역할 |
|------|------|
| `main.py` | 일일 체크(조건 충족 시에만 발송) |
| `modules/` | fear_greed, yahoo, rsi, telegram |
| `.env` | `SIGNAL_TICKERS`(기본 QLD), 텔레그램 |

- **매수 조건**: 공포탐욕 < 20 AND RSI ≤ 30 AND VIX ≥ 30 (무릎)
- **매도 조건**: 공포탐욕 ≥ 80 AND RSI ≥ 70 AND VIX ≤ 15 (어깨)
- 데이터: CNN dataviz API(공포탐욕), yfinance(VIX `^VIX`, 종목 종가)
- 실행 모드: `./run.sh`(조건부 발송) / `--print`(콘솔만) / `--test`(현재 지표 발송) / `--sample both`(샘플 메시지)

## 6. 외부 API 연동

- **한국투자증권(KIS) OpenAPI** — 무한매수법 주문/체결(`infinite-buy/src/kisApi.ts`). IP 등록 방식이라 self-hosted runner 필수
- **토스증권 OpenAPI** — 보유종목 조회. **IPv4 강제 필수**(dual-stack IPv6 나가면 `unidentified-client` 401), `X-Tossinvest-Account`는 accountSeq. 스펙 `docs/toss-api/`
- **텔레그램** — 알림 전부 **Alram🔔**(`@idca_local_bot`) 한 봇으로 통합(infinite-buy/signal-alert/lotto 공유). 대화형은 Claude Code 텔레그램 플러그인(별도 봇 서버 없음)
- **Claude CLI** — 가계부 AI 리포트 생성(sonnet)

## 기술 스택

- **Backend**: Node.js 20(financial, server, infinite-buy), Python 3.11(lotto, signal-alert)
- **Frontend**: 순수 HTML/JS(financial, ECharts + jSpreadsheet)
- **데이터 저장**: **SQLite DB**(가계부 `financial/data/homi.db`, 단일 진실원) + git 관리 파일(export 사본·상태 JSON)
- **자동화**: macOS launchd(가계부 서버·로또·signal-alert·VR 리마인더·삼성카드·LAN IP), GitHub Actions self-hosted runner(무한매수법·리포트)
- **배포**: 로컬 Express(financial, LAN 전용), 로컬 실행(lotto, signal-alert)

## GitHub Actions 워크플로우 현황

| 워크플로우 | 스케줄 | 상태 |
|-----------|--------|------|
| `infinite-buy-open.yml` / `close.yml` | 평일 00:00 / 07:00 KST | 활성(`config.json` enabled로 제어) |
| `infinite-buy-toggle.yml` | 수동 | 활성 |
| `infinite-buy-v4-open.yml` / `close.yml` | 수동(스케줄 주석) | `config-v4.json` enabled=false면 미동작 |
| `financial-report.yml` | 매달 1일 | 활성(월간 AI 리포트) |
| `financial-receipt.yml` | 트리거 | 활성(영수증 분석) |
| `lotto-*.yml`, `vr-reminder.yml` | — | 로컬 launchd와 병행 |
