# Architecture (현행)

> 최종 업데이트: 2026-04-11

## 프로젝트 구조

```
homi/
├── financial/          # 가계부 대시보드 (GitHub Pages 정적 사이트)
├── server/             # 텔레그램 봇 서버 (Node.js 로컬 폴링)
├── lotto/              # 로또 자동구매 (Python, 로컬 launchd)
├── infinite-buy/       # 무한매수법 자동매매 (TypeScript, GitHub Actions)
├── 가계부/              # 카드 명세서 파싱 결과 CSV (GitHub API로 커밋)
├── .github/workflows/  # GitHub Actions 워크플로우
└── docs/               # 문서
```

## 1. financial/ — 가계부 대시보드

**배포**: GitHub Pages 정적 사이트 (`https://leejangpu.github.io/homi/financial/`)

| 파일 | 역할 |
|------|------|
| `index.html` | 자체 포함 SPA (ECharts + jSpreadsheet) |
| `2025.csv`, `2026.csv` | 연간 수입/지출/자산 데이터 |
| `summary.json` | AI 브리핑 (월별 요약) |
| `expense_detail.json` | 가맹점별 상세 지출 내역 |

- 클라이언트에서 CSV를 fetch → JavaScript로 파싱 → 차트/테이블 렌더링
- 탭 구성: 대시보드, 소득, 저축, 지출, 자산
- 인증: `sessionStorage` 기반 간단 패스워드

## 2. server/ — 텔레그램 봇 서버

**실행**: 로컬에서 `cd server && npm start`

| 파일 | 역할 |
|------|------|
| `index.js` | 메인 봇 로직 (getUpdates 폴링, Gemini 연동) |
| `auth.js` | Google OAuth2 (Sheets 읽기용) |
| `.env` | TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, GITHUB_TOKEN 등 |

**핵심 기능**:
- Telegram getUpdates 폴링 (30초 timeout)
- 카드 명세서(XLSX) 수신 → Gemini AI 파싱 → GitHub API로 `가계부/` CSV 커밋
- Google Sheets 연동 (호미 가계부, 재무재표)
- 대화 히스토리 (메모리 기반, 1시간 TTL)

**데이터 흐름**:
```
Telegram XLSX 수신 → Gemini 파싱 → GitHub CSV 커밋 → financial/index.html에서 표시
```

## 3. lotto/ — 로또 자동구매

**실행**: 로컬 macOS launchd

| 파일 | 역할 |
|------|------|
| `main.py` | 메인 (Playwright 브라우저 자동화) |
| `run.sh` | 구매 래퍼 (launchd에서 호출) |
| `check.sh` | 당첨확인 래퍼 |
| `modules/` | auth, purchase, history, telegram 등 |
| `.env` | 로또 사이트 계정, 텔레그램 알림 설정 |

**실행 모드**:
```bash
python main.py              # 랜덤번호 5게임 구매
python main.py --auto       # 사이트 자동선택
python main.py --check      # 당첨 내역 조회
python main.py --dry-run    # 로그인 테스트
```

**스케줄**:
- `com.homi.lotto-purchase.plist` — **매일 10:00 KST** (구매 여부는 `main.py`가 판단)
- `com.homi.lotto-check.plist` — 매주 토요일 22:00 KST
- plist 위치: `~/Library/LaunchAgents/`

**구매 게이트 / 재시도 로직** (`main.py run()`):
- 매일 10:00 실행되지만 실제 구매는 아래 조건에서만 수행
  - 일요일은 스킵 (다음 회차 조기구매 방지)
  - 목표 회차(`get_target_round`)가 이미 `history.json`에 있으면 스킵 → **구매 성공 시 재시도 안 함**
  - 미구매 회차면 구매 진행
- **예치금 부족 등 실패 시** history 미저장 + 텔레그램 알림("내일 같은 시간에 다시 시도") → **다음날 같은 시간 자동 재시도**, 성공할 때까지 반복 (그 주 토요일 추첨 전까지)
- 실패 판별: `purchase.py`의 `_detect_purchase_error()`가 구매 오류 팝업(`[예치금] 초과되었습니다` 등)을 감지. 성공했을 때만 `history.json`에 저장하므로 history 존재 = 재시도 불필요의 단일 기준

## 4. infinite-buy/ — 무한매수법 자동매매

**실행**: GitHub Actions (self-hosted runner)

| 파일 | 역할 |
|------|------|
| `src/main-open.ts` | 장 오픈 시 LOC/LIMIT 주문 제출 |
| `src/main-close.ts` | 장 마감 시 체결 확인 & 사이클 동기화 |
| `src/calculator.ts` | 분할매수/매도 계산 (전반전/후반전/쿼터모드) |
| `src/kisApi.ts` | 한국투자증권 OpenAPI 연동 |
| `config.json` | 종목, 분할수, 목표수익률 설정 |
| `state/` | 사이클 상태 JSON (per ticker) |
| `.env` | KIS API 키, 텔레그램 알림 |

**현재 상태**: `config.json`에서 `enabled: false` (정지 중)

**스케줄**:
- `infinite-buy-open.yml` — 평일 00:00 KST (정규장 개장)
- `infinite-buy-close.yml` — 평일 07:00 KST (정규장 마감)
- `infinite-buy-toggle.yml` — 수동 on/off 토글

## GitHub Actions 워크플로우 현황

| 워크플로우 | 스케줄 | 상태 |
|-----------|--------|------|
| `lotto-purchase.yml` | ~~월요일 10:00 KST~~ | **비활성** (로컬 launchd로 전환) |
| `lotto-check.yml` | ~~토요일 22:00 KST~~ | **비활성** (로컬 launchd로 전환) |
| `infinite-buy-open.yml` | 평일 00:00 KST | 활성 (config.enabled=false로 정지 중) |
| `infinite-buy-close.yml` | 평일 07:00 KST | 활성 |
| `infinite-buy-toggle.yml` | 수동 | 활성 |

## 기술 스택

- **Backend**: Node.js 20 (server, infinite-buy), Python 3.11 (lotto)
- **Frontend**: 순수 HTML/JS (financial)
- **API 연동**: Telegram Bot, Gemini AI, KIS 증권, Google Sheets, GitHub
- **자동화**: macOS launchd (로또), GitHub Actions self-hosted runner (무한매수법)
- **데이터 저장**: CSV/JSON 파일 (git 관리)
- **배포**: GitHub Pages (financial), 로컬 실행 (server, lotto)
