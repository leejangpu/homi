# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 언어

모든 답변은 한국어로 작성합니다.

## 프로젝트 개요

Homi는 가족용 퍼스널 자동화 프로젝트입니다. 네 가지 주요 서브시스템으로 구성됩니다:

1. **가계부 대시보드** (`financial/`) — 로컬 Express 서버 (LAN 내 접속 전용), 순수 HTML/JS (ECharts + jSpreadsheet)
2. **로또 자동구매** (`lotto/`) — Python + Playwright 브라우저 자동화, macOS launchd 스케줄
3. **무한매수법 자동매매** (`infinite-buy/`) — TypeScript, 한국투자증권 + 토스증권 API, 집 맥 macOS launchd (KIS IP 등록 때문)
4. **시장 신호 알림** (`signal-alert/`) — Python, 공포탐욕+VIX+RSI 교집합 모니터, macOS launchd

> **상세 아키텍처**: `docs/02-architecture.md` 참고

## 기능별 빠른 이동 (코드 진입점 → 상세문서)

무엇을 만지든 **여기서 코드 진입점과 상세문서로 바로 점프**한다. 상세문서가 없는 기능은 코드가 진실원.

| 기능 | 코드 진입점 | 상세문서 |
|---|---|---|
| 가계부 웹/대시보드 | `financial/server.js`(3000), `financial/index.html` | `docs/02-architecture.md` §1 |
| 가계부 데이터(자산·지출·소득·저축) 조회 | `financial/db.js`·`store.js`·`sheet.js`, DB `financial/data/homi.db` | ↓ [가계부 데이터 조회](#가계부-데이터-조회-자산지출소득저축) 절 |
| 가계부 DB 구조·전환 | `financial/db.js`, `financial/gitsync.js` | `financial/docs/db-migration-plan.md` |
| AI 월간 리포트 | `financial/generate-report.sh` → `summary.json` | ↓ [주요 명령어](#주요-명령어) |
| 영수증 분석 | `financial/analyze-receipt.sh`, `financial/server.js`(`/analyze-receipt`) | `docs/02-architecture.md` §1 |
| **데일리 루틴**(카드 명세서 지출 반영 등) | 현재: `financial/sync_samsungcard.py`(+`fetch_`/`decrypt_samsungcard.py`) | **`daily-routine/README.md`**, [[project_samsungcard_decrypt]] |
| **VR 계산기(밸류 리밸런싱)** | `financial/index.html`(`vrCalculate`), `financial/api.js`(`/api/vr*`) | **`financial/docs/vr-calculator.md`** |
| 무한매수법 v2.2/v3.0 | `infinite-buy/src/main-{open,close}.ts`, `calculator.ts`, `kisApi.ts` | `docs/02-architecture.md` §2 |
| 무한매수법 v4.0 | `infinite-buy/src/v4/main-{open,close}-v4.ts` | `infinite-buy/V4-SPEC.md`, `infinite-buy/docs/V4-RUNBOOK.md` |
| 로또 자동구매 | `lotto/main.py`, `lotto/modules/` | `docs/02-architecture.md` §4 |
| 시장 신호 알림 | `signal-alert/main.py`, `signal-alert/modules/` | `docs/02-architecture.md` §5 (전용문서 없음) |
| 토스증권 OpenAPI | `infinite-buy/src`(토스 호출부) | `docs/toss-api/` + ↓ [외부 API](#외부-api) |
| KIS OpenAPI 레퍼런스 | `infinite-buy/src/kisApi.ts` | `infinite-buy/docs/kis-api/` |
| 시스템 헬퍼(LAN IP·VR 리마인더·VR 가격알림·자동커밋) | `scripts/{lan-ip-notify.sh,vr-reminder.js,vr-price-alert.js,auto-commit.sh}` | VR 가격알림은 `financial/docs/vr-calculator.md` §가격 알림, 나머지는 코드가 진실원 |

> 전체 문서 목록·상태는 아래 [문서 맵](#문서-맵-어디에-무슨-문서가-있나) 참조.

## 디렉토리 맵

루트 디렉토리에서 어디에 뭐가 있는지 한눈에 보는 인덱스. 새 파일을 어디 둘지 결정하거나 기능 찾을 때 먼저 여기를 봅니다.

| 디렉토리 | 언어 | 역할 | 진입점 |
|---|---|---|---|
| `financial/` | Node + Python | 가계부 대시보드 웹(**SQLite DB `data/homi.db`**, 셀단위 실시간저장+SSE+git브리지), AI 리포트, 카드 명세서 지출 반영(데일리 루틴 코드 거처), VR 계산기 | `server.js`, `db.js`/`store.js`/`api.js`/`gitsync.js`, `generate-report.sh`, `sync_samsungcard.py` |
| `lotto/` | Python | 동행복권 자동구매/당첨조회 (Playwright) | `main.py`, 모듈: `modules/{auth,purchase,history,number_generator,telegram}.py` |
| `infinite-buy/` | TypeScript | 무한매수법 자동매매 — KIS API 주문, 토스 API 보유종목 조회. **v2.2/v3.0**(`calculator.ts`)와 **v4.0**(`src/v4/`, 라오어 언이시트 포팅, 별도 모듈)이 공존 | `src/main-open.ts`, `src/main-close.ts`, `src/v4/main-{open,close}-v4.ts`, `src/{kisApi,calculator,stateManager}.ts` |
| `signal-alert/` | Python | 공포탐욕+VIX+RSI 교집합 타점 알림 (QLD 기본) | `main.py`, 모듈: `modules/{fear_greed,yahoo,rsi,telegram}.py` |
| `daily-routine/` | Markdown(+향후 코드) | **데일리 루틴** 상위 개념·규약. 매일 도는 개인 자동화 모음(현재: 카드 명세서 지출 반영). 향후 루틴 코드 거처 | `README.md` |
| `scripts/` | Bash/Node | 시스템 헬퍼: LAN IP 알림, VR 리마인더, VR 가격 알림(장중 밴드 이탈→텔레그램), Stop 훅 자동 커밋 | `lan-ip-notify.sh`, `vr-reminder.js`, `vr-price-alert.js`, `auto-commit.sh` |
| `docs/` | Markdown | 아키텍처 문서, 토스 API 스펙 (`docs/toss-api/`) | `02-architecture.md` |
| `infinite-buy/docs/` | Markdown | V4.0 사양(`../V4-SPEC.md`)·런북(`V4-RUNBOOK.md`), KIS API 로컬 레퍼런스(`kis-api/`), 언이시트 원본 메모 | `V4-RUNBOOK.md` |
| `logs/` | — | 프로젝트 공통 로그 보관 | — |
| `가계부/` | 영수증 이미지 | 영수증 원본 보관 (분석은 `financial/analyze-receipt.sh`) | — |

## 문서 맵 (어디에 무슨 문서가 있나)

**이 CLAUDE.md가 사실상 최신 단일 인덱스다.** 나머지 문서는 서브시스템별로 흩어져 있으니 아래에서 찾는다. **낡은 문서는 신뢰하지 말 것** — 상태 열을 반드시 확인.

| 문서 | 다루는 것 | 상태 |
|---|---|---|
| `CLAUDE.md` (이 파일) | 전체 인덱스·디렉토리/스케줄러/봇 맵·명령어·아키텍처 요약·가계부 DB 조회·토스 API | ✅ **최신, 우선 참조** |
| `docs/02-architecture.md` | 현행 아키텍처 서술(4 서브시스템 + VR + 외부 API) | ✅ 최신(2026-07-16 현행화). CLAUDE.md와 충돌 시 CLAUDE.md 우선 |
| `financial/docs/db-migration-plan.md` | 가계부 SQLite 전환 설계·런북 | ✅ 유효 (DB 구조 근거) |
| `financial/docs/vr-calculator.md` | VR(밸류 리밸런싱) 계산기 공식·필드·API·사이클 | ✅ 최신 |
| `daily-routine/README.md` | **데일리 루틴** 개념·규약·현재 루틴 목록·추가법 | ✅ 최신 |
| `infinite-buy/V4-SPEC.md` | 무한매수법 V4.0 사양 (언이시트 포팅) | ✅ 유효, V4 권위 사양 |
| `infinite-buy/docs/V4-RUNBOOK.md` | V4.0 운영 시작법 | ✅ 유효 |
| `infinite-buy/docs/quarter-loss-cut-spec.md` (+ `unisheet-v2.2-source.xlsx`) | **V2.2 쿼터손절모드 권위 사양** (언이시트 셀 수식 해독) | ✅ 최신, v2.2 쿼터손절 진실원 |
| `infinite-buy/docs/kis-api/README.md` | KIS API 로컬 레퍼런스 | ✅ 유효 |
| `docs/toss-api/{overview,api-reference}.md`, `docs/toss-api/*.json` | 토스증권 OpenAPI 스펙 | ✅ 유효 (소스: `openapi.json`) |

**문서 공백(전용 문서 없음 → 코드가 진실원)**:
- **signal-alert/** — 전용 `.md` 없음. 사양은 CLAUDE.md "시장 신호 알림" 절 + `signal-alert/main.py`/`modules/`.
- **가계부 웹/DB 상세** — CLAUDE.md "가계부 데이터 조회" 절 + `financial/docs/db-migration-plan.md`가 커버.

> 새 서브시스템·구조를 추가하면 **여기 문서 맵과 디렉토리 맵을 먼저 갱신**하고, `docs/02-architecture.md`(현행 서술본)도 함께 맞춘다.

## 텔레그램 봇 매핑

알림은 모두 **Alram🔔** (`@idca_local_bot`, 토큰 시작 `8038597251`) 한 봇으로 통합. 사용자 DM(`chat_id=515180873`)으로 전송. 환경변수 키 이름은 모두 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

사용처: `infinite-buy/`, `signal-alert/`, `lotto/` 전부.

이 자리의 Claude Code 대화는 별도 플러그인 봇 — Alram🔔과 무관.

> 과거에 로또용으로 쓰던 **Homi** (`@homi1801_bot`, 토큰 시작 `8317143838`) 봇은 2026-06-21 부로 미사용 (코드에서 참조 없음). 봇 자체는 텔레그램에 살아있지만 새 코드에서 쓰지 않음.

## 스케줄러 매핑

각 자동화가 어떤 스케줄러에서 도는지.

| 시스템 | 스케줄러 | 워크플로/Plist |
|---|---|---|
| 무한매수법 v2.2/v3.0 장 오픈/마감 | **macOS launchd** (집 맥, KIS IP 등록 때문). open KST 04:00·close KST 07:00, `open.sh`/`close.sh`가 `npx tsx` 실행 후 `infinite-buy-bot` 신원으로 자체 커밋·푸시 | `~/Library/LaunchAgents/com.homi.infinite-buy-{open,close}.plist`, `infinite-buy/{open,close}.sh`. (워크플로 `.github/workflows/infinite-buy-{open,close,toggle}.yml`은 `cron` 주석 처리 — `workflow_dispatch` 수동 트리거용으로만 잔존) |
| 무한매수법 **v4.0** 장 오픈/마감 | GitHub Actions self-hosted runner (수동 트리거, 스케줄 주석. `config-v4.json` enabled=false면 미동작) | `.github/workflows/infinite-buy-v4-{open,close}.yml` |
| 가계부 월간 리포트 | GitHub Actions | `.github/workflows/financial-report.yml` |
| 가계부 영수증 분석 | GitHub Actions | `.github/workflows/financial-receipt.yml` |
| 로또 구매/당첨조회 | macOS launchd + GH Actions | `com.homi.lotto-{purchase,check}.plist`, `.github/workflows/lotto-*.yml` |
| 가계부 웹 서버 | macOS launchd | `com.homi.serve.plist` |
| 시장 신호 알림 | macOS launchd (매일 KST 08:00) | `com.homi.signal-alert.plist` |
| VR(밸류 리밸런싱) 리마인더 | macOS launchd + GH Actions | `com.homi.vr-reminder.plist`, `vr-reminder.yml` |
| VR 가격 알림 (장중 매시 밴드 이탈 감시 → Alram🔔) | macOS launchd (매시 05분 기동, 토스 캘린더로 KR/US 개장 판정 후 장중에만 조회) | `com.homi.vr-price-alert.plist` → `scripts/vr-price-alert.js` |
| LAN IP 변경 알림 | macOS launchd | `com.homi.lan-ip-notify.plist` |
| **데일리 루틴** (카드 명세서 지출 반영 등 → 아래 절) | macOS launchd | `com.homi.samsungcard-sync.plist` 외 |
| 텔레그램 Claude 플러그인 | macOS launchd (워치독 포함) | `com.homi.telegram-{claude,watchdog}.plist` |

## 데일리 루틴 (매일 자동 실행 작업)

매일 정해진 시각에 도는 **개인 자동화 잡무 모음**의 상위 개념. 앞으로 이런 매일 작업이 더 추가된다 → 새 코드는 원칙적으로 `daily-routine/`에 두고 **여기 표에 등록**한다(기존 서브시스템에 강결합이면 그쪽에 두고 분류만 여기).

| 루틴 | 시각(KST) | 코드 진입점 | plist | 상태 |
|---|---|---|---|---|
| 카드 명세서 지출 반영 (현재 삼성카드) | 09:00 | `financial/sync_samsungcard.py` | `com.homi.samsungcard-sync.plist` | ✅ 운영중 |

- **카드 명세서 지출 반영**: Gmail에서 카드사 이용대금 메일(현재 `from:bill@samsungcard.com`) → 새 명세서만 선별(`financial/processed_statements.json`) → 첨부 복호화(Keychain)→PDF → `analyze-receipt.sh`(Claude 분석) → `expense_detail.json`+가계부 반영. 삼성카드 코드가 `financial/`에 사는 이유·추가법은 **`daily-routine/README.md`** 참고.
- 규약: 새 루틴 = `daily-routine/<이름>/` 스크립트 + `com.homi.<이름>.plist`(또는 GH Actions) + 이 표 한 줄 + 필요시 Alram🔔 알림.

## 주요 명령어

### 가계부 AI 리포트 생성
```bash
cd financial && ./generate-report.sh 2026 4  # 특정 월 리포트 생성
cd financial && ./generate-report.sh          # 현재 월 리포트 생성
```
스케줄: GitHub Actions (`financial-report.yml`, 매달 1일 자동 실행)

### 로또 자동구매
```bash
cd lotto
source .venv/bin/activate
python main.py              # 랜덤번호 5게임 구매
python main.py --auto       # 사이트 자동선택
python main.py --check      # 당첨 내역 조회
python main.py --dry-run    # 로그인 테스트
```
환경 변수: `lotto/.env` (로또 사이트 계정, 텔레그램 알림)
스케줄: macOS launchd (`~/Library/LaunchAgents/com.homi.lotto-*.plist`)

### 무한매수법 자동매매
```bash
cd infinite-buy && npm install
npx tsx src/main-open.ts    # 장 오픈 시 주문
npx tsx src/main-close.ts   # 장 마감 시 체결 확인
```
환경 변수: `infinite-buy/.env` (KIS API 키, 토스 API 키, 텔레그램 알림)
스케줄: macOS launchd (`com.homi.infinite-buy-{open,close}.plist` → `open.sh`/`close.sh`, KST 04:00/07:00). GH Actions 워크플로는 `cron` 주석 처리·수동 트리거만 남음
위는 **v2.2/v3.0**(`config.json`의 `strategyVersion`). **v4.0은 별도** — 아래.

### 무한매수법 V4.0 (라오어 언이시트 포팅, 별도 모듈 `src/v4/`)
```bash
cd infinite-buy
# 백테스트 (yfinance 실데이터, 결정론적 시뮬)
npx tsx src/v4/backtest/run.ts TQQQ        # 단일종목 백테스트 + 사이클/로그
npx tsx src/v4/backtest/compare.ts SOXL    # v2.2/v3.0/v4.0 비교
# 검증 테스트
npx tsx src/v4/test-anchors.ts             # 코어 공식 ↔ 문서 예시
npx tsx src/v4/test-port.ts                # 스크립트 포팅 정확성
# 프로덕션 (DRY-RUN 기본, 실주문은 V4_LIVE_ORDERS=YES_REALLY 필요)
npx tsx src/v4/main-close-v4.ts            # 장 마감: 실보유 동기화→상태/다음주문 영속
npx tsx src/v4/main-open-v4.ts             # 장 개시: 다음주문 제출(게이트)
```
- 설정: `infinite-buy/config-v4.json` (`enabled`, `capitalSource`, 종목별 분할/목표/큰수)
- 권위 출처: 언이시트 Apps Script. 사양 `infinite-buy/V4-SPEC.md`, 시작법 `infinite-buy/docs/V4-RUNBOOK.md`
- 실주문 3중 가드: `enabled` + `V4_LIVE_ORDERS=YES_REALLY` + DRY-RUN 기본
- 기존 v2.2/v3.0과 완전 분리(상태파일 `state/v4-*.json`, 워크플로 별도). **기존 실거래 무영향**

### 시장 신호 알림
```bash
cd signal-alert && ./run.sh                 # 일일 체크 (조건 충족시에만 발송)
cd signal-alert && ./run.sh --print         # 현재 지표 콘솔 출력만
cd signal-alert && ./run.sh --test          # 조건 무관, 현재 지표를 텔레그램으로
cd signal-alert && ./run.sh --sample both   # 가짜 데이터로 매수/매도 샘플 메시지 발송
```
- 매수 조건: 공포탐욕 < 20 AND RSI ≤ 30 AND VIX ≥ 30 (무릎 타점)
- 매도 조건: 공포탐욕 ≥ 80 AND RSI ≥ 70 AND VIX ≤ 15 (어깨 타점)
- 데이터 소스: CNN dataviz API (공포탐욕), yfinance (VIX `^VIX`, 종목 종가)
- 감시 종목: `.env`의 `SIGNAL_TICKERS` (기본 `QLD`, 쉼표로 다중 가능)
- 알림 봇: Alram🔔 (`8038597251` 토큰, 무한매수법과 공유)
- 스케줄: macOS launchd `com.homi.signal-alert.plist` (매일 KST 08:00)

## 아키텍처 핵심

- **가계부 웹**: 로컬 Express 서버 (`financial/server.js`, port 3000). LAN 내 접속 전용(외부 터널 없음). `financial/index.html`이 `/api/*`에서 데이터를 fetch하여 차트/테이블 렌더링. 영수증 분석은 same-origin(`/analyze-receipt`)으로 server.js가 처리
- **가계부 데이터 = SQLite DB (authoritative)**: `financial/data/homi.db` (better-sqlite3 임베디드, WAL, git 제외). 시트는 **셀 단위 저장 + 버전 낙관적 잠금**, 편집은 **실시간 PATCH**(`PATCH /api/budget/cell`), 서버가 합계 재계산, **SSE**(`/api/stream`)로 타 탭 실시간 반영. 모듈: `db.js`(연결·스키마)/`sheet.js`(파싱·계산 포팅)/`store.js`(데이터접근·잠금)/`api.js`(라우터·SSE)/`gitsync.js`(git 브리지)/`scripts/migrate-to-db.js`. 설계·런북: `financial/docs/db-migration-plan.md`
  - **Git Sync (기계적)**: DB 변경 → export(사람이 읽는 CSV/JSON) → 디바운스 git commit/pull/push. 외부(CI·영수증·타기기 pull)로 파일이 바뀌면 → DB import(해시 에코방지) → SSE. git은 백업/CI교환 채널이고 DB가 단일 진실원.
  - **폐기**: 전체파일 덮어쓰기 `/save`·`/save-vr`·`/save-vr-history`는 410(clobber 방지). 신규는 `/api/*`.
  - **런타임 주의**: node는 Homebrew `node@20` (`~/.local/bin/node`가 `/opt/homebrew/opt/node@20/bin/node`로 심볼릭). 과거 `~/.hermes` node는 제거됨. better-sqlite3는 node20 ABI 프리빌트.
- **AI 리포트**: `financial/generate-report.sh` → Claude CLI sonnet → `financial/summary.json` 갱신 → git push (파일 기반, gitsync가 DB로 흡수)
- **영수증/summary**: 파일 기반 유지(CI·영수증이 파일을 씀). gitsync import 브리지가 DB로 동기
- **텔레그램 대화**: Claude Code 텔레그램 플러그인으로 직접 대화 (별도 봇 서버 없음)

## 가계부 데이터 조회 (자산·지출·소득·저축)

> **사용자가 자산/지출/소득/저축 등 가계부 수치를 물으면 여기부터 본다.**
> **CSV(`financial/2026.csv` 등)는 gitsync가 내보낸 사람이 읽는 사본일 뿐, stale일 수 있다. 단일 진실원은 SQLite DB `financial/data/homi.db`. 항상 DB를 직접 쿼리해서 답한다.**

**접근**: `cd financial && node -e "const db=require('better-sqlite3')('data/homi.db',{readonly:true}); ...(쿼리)..."` — 반드시 `readonly:true`. better-sqlite3는 이미 `financial/node_modules`에 설치돼 있음(node@20 ABI). WAL 모드라 `homi.db-wal`에 최신 미체크포인트 변경이 있을 수 있으나 better-sqlite3로 열면 자동 반영됨.

### 가계부 시트 = `budget_cell` (셀 단위 저장)
스프레드시트를 셀 하나=한 행으로 저장. 컬럼: `year, r(행0-based), c(열0-based), raw(원본문자열), version, updated_at`.

- **연도별 시트**: `budget_sheet`에 `year, n_rows, n_cols`. 현재 2025, 2026 존재.
- **열(c) 매핑** (2026 기준):
  - `c=1` **통장분류** (섹션 라벨: 정기소득/비정기소득/저축/고정지출/변동지출/비정기지출/자산/부동산/연금저축/주식/대출 등)
  - `c=2` **상세항목** (예: 급여소득, 용인 수지구, 카카오페이…)
  - `c=3` **분류** (사람: 순애/장훈/공통, 또는 배당주/직투/VR 등 태그)
  - `c=4`부터 **월별 값**: `c=4`→01월, `c=5`→02월, … `c=9`→06월, `c=10`→07월 … (즉 `c = 3 + 월`)
- **행(r) 구조는 연도마다 다르므로 하드코딩 금지.** 섹션은 `c=1`의 라벨로 식별한다. 2026 레이아웃 예: r0 헤더, 소득 계=r7, 저축 계=r19, 지출 계=r49, `급여소득 대비 잔액`=r50, **`자산(월말업데이트)` 헤더=r53**, 자산 항목 r54~r89, **`유동자산계`=r90, 순자산 `계`=r92**. 자산 항목 아래 홀수행(r55,57…)은 전월대비 증감률(▲▼%)이라 값이 아님 — 건너뛴다.
- **raw 값 파싱 주의**:
  - `₩`, 쉼표, 공백 포함 → 숫자화 전에 제거.
  - **`=`로 시작하면 수식**(예: `=6857412+18397815`, `=582200+5869360`) → 평가해서 합산. 여러 계좌 합을 한 셀에 적은 것.
  - 대출은 음수(`-₩429,665,732`). 총자산(gross) 계산 시 대출 제외, **순자산**은 대출까지 더함.
- **최신 월 판단**: 자산 행에서 값이 채워진 가장 큰 `c`. 자산은 "월말업데이트"라 당월이 비어있을 수 있음 → 값 있는 마지막 달로 답하고 기준 월을 명시.

### 자산 분류 (사용자 합의 기준, 2026-06 검증됨)
- **부동산**: `통장분류=부동산`
- **금융자산(투자·연금)**: 연금저축 + 주택청약 + ISA + 주식(전 계좌)
- **현금성자산**: 파킹통장 + 나눠모으기 + 저축(예금)
- **대출**(부채, 자산 아님): 주택담보대출 + 어머님대출 — 총자산에서 제외, 순자산에서 차감
- 경계 항목(주택청약·예금)은 관점 따라 현금성으로 재분류 가능 — 답변 시 언급.

### 지출 상세 = `expense_month`
`year, month, data(JSON)`. `data.items[]` = `{날짜, 가맹점, 카드, 금액, 카테고리, source}`. 영수증 분석 / 카드 명세서 지출 반영 루틴으로 채워지는 **거래 단위** 명세. 시트의 변동지출 합계와 별개의 원천 데이터.

### 기타 테이블
- `ai_summary` — 월별 AI 리포트 JSON (`generate-report.sh` 산출, `summary.json`의 DB판).
- `vr_tracker` / `vr_history` — VR(무한매수법 관련) 계산기 상태.
- `ext_mirror` — 외부(영수증/summary 등) 파일 미러 (gitsync import 에코 방지용).
- `meta` — 키/값 메타.

### 조회 레시피 (자산 구성 예)
```bash
cd financial && node -e '
const db=require("better-sqlite3")("data/homi.db",{readonly:true});
const Y=2026, MON=6, C=3+MON;  // 원하는 연/월
const cells=db.prepare("SELECT r,c,raw FROM budget_cell WHERE year=?").all(Y);
const g={}; for(const {r,c,raw} of cells) g[r+"_"+c]=raw;
const num=s=>{ if(!s) return 0; s=String(s).replace(/[₩,\s]/g,""); if(s.startsWith("=")) return s.slice(1).split("+").reduce((a,b)=>a+(+b||0),0); return +s||0; };
// c=1 라벨로 자산 섹션(자산 헤더 아래)만 순회하는 식으로 분류·합산
'
```
(실제 답변 시엔 위 패턴으로 `c=1` 섹션 라벨을 읽어 부동산/금융/현금성으로 분류·합산하고, 대출은 음수로 순자산 계산에 반영.)

## 외부 API

### 토스증권 OpenAPI

- **Base URL**: `https://openapi.tossinvest.com`
- **인증**: OAuth 2.0 Client Credentials Grant. `POST /oauth2/token` 으로 access token 발급 (TTL 86,399초 ≈ 24h)
- **추가 헤더**: 계좌·자산·주문 카테고리는 `X-Tossinvest-Account: {accountSeq}` 필수. **`accountSeq`(정수 1, 2…)** 이지 `accountNo`(11자리 문자열)가 아님 — 주의
- **환경 변수** (`infinite-buy/.env`):
  - `TOSS_API_KEY` — client_id (`tsck_live_*`)
  - `TOSS_SECRET_KEY` — client_secret (`tssk_live_*`)
- **⚠️ IPv4 강제 필수**: 토스 콘솔에 등록된 허용 IP는 IPv4 `211.241.110.56`. 이 머신은 dual-stack이라 기본 라우팅이 IPv6 (`2406:5900:11a9:c11:…`, macOS 프라이버시 확장으로 임시 주소 회전)로 나가서 `unidentified-client` 401을 받음. **클라이언트에서 반드시 IPv4 강제** — curl은 `-4`, Node는 `agent: new https.Agent({ family: 4 })`, Python httpx는 `transport=httpx.HTTPTransport(local_address="0.0.0.0")` 또는 `socket.AF_INET` 고정
- **API 스펙 / 레퍼런스**: `docs/toss-api/`
  - `openapi.json` — 통합 OpenAPI 3.1 스펙 (소스 오브 트루스, 21개 엔드포인트)
  - `overview.md` — 가이드 / 빠른 시작 / 에러 코드 표
  - `api-reference.md` — 마크다운 레퍼런스
  - `by-tag/*.json` — 섹션별 분리본 (auth, market-data, stock-info, market-info, account, asset, order, order-history, order-info)
- **카테고리 요약**: Auth / Market Data (호가·가격·체결·캔들) / Stock Info / Market Info (환율·장 운영) / Account / Asset (보유 주식) / Order (생성·정정·취소) / Order History / Order Info (매수가능금액·판매가능수량·수수료)
- **호출 예시**:
  ```bash
  # 토큰 발급 (IPv4 강제)
  curl -4 -s -X POST 'https://openapi.tossinvest.com/oauth2/token' \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "grant_type=client_credentials&client_id=$TOSS_API_KEY&client_secret=$TOSS_SECRET_KEY"

  # 보유 주식 조회
  curl -4 -s 'https://openapi.tossinvest.com/api/v1/holdings' \
    -H "Authorization: Bearer $TOKEN" \
    -H 'X-Tossinvest-Account: 1'
  ```

## 작업 방식

### 모델 선택 기준

| 작업 유형 | 사용 모델 | 모델 ID |
|---|---|---|
| 분석, 추론, 계획 수립 | **Claude Opus 4.6** | `claude-opus-4-6` |
| 코딩, 수정, 계획 실행 | **Claude Sonnet 4.6** | `claude-sonnet-4-6` |

- **Opus 4.6 사용**: 문제 분석, 아키텍처 설계, 구현 계획 수립, 복잡한 추론이 필요한 의사결정
- **Sonnet 4.6 사용**: 코드 작성/수정, 파일 편집, 수립된 계획의 단순 실행, 반복적 처리 작업
- 코드 수정이 필요한 경우, 명확한 지시와 함께 Sonnet 서브에이전트를 생성하여 병렬 처리

## 기술 스택

- Node.js 20, Python 3.11
- 패키지 매니저: npm (Node), pip + venv (Python)
- 자동화: macOS launchd (로또, 무한매수법 v2.2/v3.0), GitHub Actions (가계부 리포트/영수증; 무한매수법 v4는 수동 트리거)
- 배포: 로컬 Express 서버 (financial, LAN 전용), 로컬 실행 (lotto)
- 테스트 프레임워크 미설정
