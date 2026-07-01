# 가계부 DB 마이그레이션 계획 (Level 2: DB + 셀 단위 PATCH + 낙관적 잠금)

> 목표: "파일 통째 덮어쓰기(last-write-wins)" 구조를 폐기하고, **셀/레코드 단위 저장 + 버전 충돌 감지 + 실시간 반영**으로 전환한다. 기존 파일 데이터는 전부 DB로 마이그레이션한다. **별도 웹서버 없이 로컬 Express 서버 하나로만** 동작하며, git은 **기계적 hook으로 백업/동기화**된다.

작성: 2026-07-01 / 대상: `financial/`

---

## 1. 핵심 아키텍처 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| DB 엔진 | **better-sqlite3** (임베디드, 동기 API, 단일 파일) | 별도 DB 프로세스 불필요 → "로컬서버만" 제약 충족. Express 단일 프로세스에 그대로 붙음 |
| DB 파일 | `financial/data/homi.db` (**git 제외**, 바이너리) | 바이너리는 git diff/merge 불가 → 저장소엔 사람이 읽는 export만 |
| Git의 역할 | **사람이 읽는 export 파일(CSV/JSON)** 의 백업·감사·CI 교환 | 기존 git 히스토리 가독성 유지 + CI(self-hosted)와의 다리 |
| 동시성 | **낙관적 잠금**: 레코드마다 `version` 정수. PATCH 시 `baseVersion` 불일치면 **409 Conflict** | 조용한 손실 원천 차단 (Level 2 정통 패턴) |
| 실시간 | 셀 편집 → **디바운스 PATCH** (즉시 저장) + **SSE**로 다른 탭에 브로드캐스트 | 오래된 탭 문제 자체가 사라짐 |
| Git 동기화 | 데이터 변경 → DB export → **디바운스 git add/commit/pull/push** hook | "기계적 hook" 요구 충족. 기존 `autoCommit` 확장 |

### 왜 DB가 "authoritative"이고 git은 export인가
- 같은 LAN IP 접속 = **하나의 서버 · 하나의 DB**. 멀티 디바이스 동시편집은 전부 이 서버의 DB로 수렴 → 동시성은 DB/API에서 해결.
- git은 앱 동작 경로가 아니라 **백업 + CI 교환 채널**. CI(GitHub Actions self-hosted)는 별도 체크아웃에서 돌며 **파일로만** 교환하므로, DB↔파일 양방향 브리지가 필수.

---

## 2. 데이터 인벤토리 (웹에 뜨는 전체 데이터)

전수조사 결과. 소유권/편집주체에 따라 4등급으로 분류.

### A등급 — 사람이 편집, 동시성 필요 → **DB 이관 + PATCH + 잠금**
| 원본 | 내용 | 편집 주체 |
|---|---|---|
| `2025.csv`, `2026.csv` | 가계부 시트(소득/저축/지출/자산 × 월) | 사람(웹) |
| `vr-state.json` | VR 계산기 트래커(티커별 ~20필드 + computed) | 사람(웹) |
| `vr-history.json` | VR 종료 사이클(append) | 사람(웹, 사이클 종료 시) |
| `expense_detail.json` | 영수증 분석 지출내역(연/월별 items) | 사람(웹) + CI(영수증 워크플로) |

### B등급 — CI 생성, 웹에선 읽기전용 → **DB에 읽기모델로 이관(파일 import)**
| 원본 | 내용 | 편집 주체 |
|---|---|---|
| `summary.json` | 월간 AI 브리핑 텍스트 | CI(`financial-report.yml`) |

### C등급 — 백엔드 부기, 웹 비노출 → 선택적 이관(후순위)
| 원본 | 내용 |
|---|---|
| `processed_statements.json` | 삼성카드 중복처리 추적 |

### D등급 — 비밀정보 → **DB/ git 절대 금지, 파일 유지**
| 원본 | 내용 |
|---|---|
| `credentials.json`, `token.json` | Google OAuth 시크릿 |

### E등급 — 외부 서브시스템 소유, 웹에선 읽기전용 표시 → **읽기전용 미러(소유권 이전 X)**
| 원본 | 소유 |
|---|---|
| `../lotto/history.json` | 로또 자동화 |
| `../infinite-buy/config.json`, `state/*.json`, `history/*.json` | 무한매수법 TS |

> E등급은 각자 스케줄러/워크플로가 자기 파일을 쓰고 자기 git 커밋을 한다. 여기서 소유권을 가져오면 그 파이프라인이 깨진다. **표시용으로만 DB에 미러링**(importer가 파일→DB 읽기전용 테이블)하고, 쓰기는 하지 않는다.

---

## 3. DB 스키마 (초안)

공통 규약: 모든 편집가능 테이블은 `version INTEGER NOT NULL DEFAULT 1`, `updated_at TEXT`, `updated_by TEXT` 를 가진다.

> **설계 수정(P1에서 확정)**: 시트는 섹션 모델이 아니라 **원본 그리드를 셀 단위로 저장**한다.
> 이유: `splitSections`가 행을 재그룹핑·변형하고 스페이서/헤더/percent/사이드테이블 행이 섞여 있어
> 섹션 모델로는 원본 CSV round-trip 충실도가 깨진다. 그리드 저장은 (1) round-trip 완벽,
> (2) 셀 단위 낙관적 잠금을 동시에 만족한다. 섹션/합계 의미는 **읽을 때 서버가 계산**(`sheet.js`로 포팅).

```sql
-- 가계부 시트: 원본 2D 그리드를 셀 단위로 저장 (r/c = CSV 배열 인덱스, 0-base). 빈 셀은 미저장.
CREATE TABLE budget_cell (
  year INTEGER NOT NULL,
  r INTEGER NOT NULL,               -- 행 인덱스
  c INTEGER NOT NULL,               -- 열 인덱스
  raw TEXT,                          -- 원본 문자열(수식 "=a+b", "₩1,000" 등 그대로 보존)
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT, updated_by TEXT,
  PRIMARY KEY(year, r, c)
);
CREATE TABLE budget_sheet (         -- 그리드 크기 보존(재구성 시 정확한 행/열 수)
  year INTEGER PRIMARY KEY, n_rows INTEGER NOT NULL, n_cols INTEGER NOT NULL, updated_at TEXT
);
-- total/balance/percent 셀은 서버가 재계산(calcAllTotals 포팅). 사람이 PATCH하는 건 data 셀.

-- VR 트래커
CREATE TABLE vr_tracker (
  ticker TEXT PRIMARY KEY,
  data TEXT NOT NULL,              -- 트래커 필드 JSON (currentPrice, gradient, ... computed 제외)
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT, updated_by TEXT
);
-- computed(currentEvaluation 등)는 저장하지 않고 조회 시 서버 계산(파생값)

CREATE TABLE vr_history (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  data TEXT NOT NULL,              -- 종료 사이클 스냅샷 JSON
  version INTEGER NOT NULL DEFAULT 1
);

-- 영수증 지출내역: 편집 단위가 월 전체(영수증 임포트)라 월별 blob로 저장
CREATE TABLE expense_month (
  year INTEGER NOT NULL, month INTEGER NOT NULL,
  data TEXT NOT NULL,             -- { cards:[...], items:[{날짜,가맹점,카드,금액,카테고리}] }
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT, updated_by TEXT,
  PRIMARY KEY(year, month)
);

-- AI 요약(B등급, 읽기모델)
CREATE TABLE ai_summary (
  year INTEGER NOT NULL, month INTEGER NOT NULL,
  data TEXT NOT NULL,              -- summary.json의 월 객체 JSON
  PRIMARY KEY(year, month)
);

-- 외부 미러(E등급, 읽기전용)
CREATE TABLE ext_mirror (
  source TEXT NOT NULL,           -- lotto | infinite-buy
  key TEXT NOT NULL,              -- history | config | state:TQQQ | history:xxx.json
  data TEXT NOT NULL,             -- 원본 JSON
  synced_at TEXT,
  PRIMARY KEY(source, key)
);

-- git 동기화 상태(무한루프 방지: 내가 export해서 만든 변경 vs 외부 유입 구분)
CREATE TABLE sync_state (
  k TEXT PRIMARY KEY, v TEXT
);
```

---

## 4. API 설계 (신규 `/api/*`, 기존 엔드포인트는 이관 후 폐기)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/budget/:year` | 시트 전체(행+셀, version 포함) |
| PATCH | `/api/budget/cell` | `{rowId, month, raw, baseVersion, password}` → data 셀 1개 수정. 버전 불일치 시 **409** + 현재값 반환. 저장 후 total/balance 재계산 및 영향 셀 브로드캐스트 |
| POST | `/api/budget/row` | 행 삽입/삭제 |
| GET | `/api/vr` / PATCH `/api/vr/:ticker` | VR 트래커 조회/수정(버전) |
| POST | `/api/vr/:ticker/end-cycle` | 사이클 종료 → history append + 트래커 리셋 |
| GET | `/api/expense/:year/:month` / PATCH `/api/expense/item` | 지출내역 |
| GET | `/api/summary` | AI 요약 |
| GET | `/api/dashboard` | 대시보드 집계(서버 계산) |
| GET | `/api/stream` (SSE) | 변경 이벤트 스트림 → 열린 탭 실시간 갱신 |

**낙관적 잠금 흐름**
1. 클라가 셀 로드 시 `version` 보관.
2. 편집 → PATCH `{baseVersion}`.
3. 서버: `SELECT version` == `baseVersion` 이면 UPDATE + `version++`, 아니면 **409** + 최신 `{raw, version}`.
4. 409 받으면 클라: 최신값 표시 + "다른 곳에서 수정됨" 배지 → 사용자 재확인.
5. 정상 저장 시 SSE로 `{rowId, month, raw, version}` 브로드캐스트 → 다른 탭 즉시 반영.

---

## 5. Git 동기화 (기계적 hook)

### 나감 (DB → git)
DB 변경 트랜잭션 커밋 후:
1. 영향받은 테이블을 **export 파일로 직렬화** (기존 포맷 유지: `2026.csv`, `vr-state.json`, `expense_detail.json` 등).
2. 디바운스(5s) 후 `git add <files> && git commit && git pull --rebase --autostash && git push`. (기존 `autoCommit` 재사용)

### 들어옴 (git → DB) — CI/타 디바이스 유입 반영
1. 주기적(예: 60s) 또는 push 직전 `git pull` 로 원격 변경 수신.
2. **export 파일 mtime/해시가 "내가 마지막으로 export한 값"과 다르면** = 외부 유입 → 해당 파일 **import → DB 반영(version++)** → SSE 브로드캐스트.
3. `sync_state`에 마지막 export 해시를 기록해 **내 export ↔ 외부 유입**을 구분(에코/무한루프 방지).

> CI(`financial-report.yml`, `financial-receipt.yml`)는 **그대로** 파일을 쓰고 커밋/푸시한다. 로컬 서버가 pull→import로 흡수하므로 CI 수정 불필요.

---

## 6. 마이그레이션 스크립트

`financial/scripts/migrate-to-db.js` (1회성, 멱등):
- 모든 A~C·E 등급 파일 파싱 → DB insert (`INSERT OR REPLACE`).
- 시트 CSV는 섹션 분리 로직(`splitSections`)·행종류 판별을 서버로 포팅해 `budget_row`/`budget_cell` 생성.
- 실행 후 **역-export** 하여 원본 파일과 **바이트/의미 동일**한지 검증(round-trip test).
- 원본 파일은 삭제하지 않음 → 그대로 export 대상이 됨.

---

## 7. 단계별 구현 순서 (하나씩, 각 단계 독립 검증)

- [x] **P0. 기반**: `better-sqlite3` + `financial/data/`(gitignore) + `db.js`(WAL, 스키마). ✅
- [x] **P1. 마이그레이션**: `scripts/migrate-to-db.js` → 전 데이터 적재, round-trip 검증(2026 바이트 동일). ✅
- [x] **P2. 읽기 API + calc 포팅**: `sheet.js`(splitSections·calcAllTotals, 2026 재계산 0셀 차이) + `store.js` + `api.js` GET. ✅
- [x] **P3. 쓰기 API + 잠금**: PATCH `/api/budget/cell` 등, baseVersion 충돌 409, 합계 자동 캐스케이드. ✅
- [x] **P4. 클라 실시간 + SSE**: index.html 재배선 — 셀 onchange→PATCH, `/api/stream` SSE, VR도 DB화. budget+VR 라이브 DB 전환. ✅
- [x] **P5. Git 동기화**: `gitsync.js` — DB→export→디바운스 commit/pull/push + 외부유입 import + 해시 에코방지 + 60s 주기 pull. ✅
- [x] **P6. 컷오버**: 위험한 전체덮어쓰기 `/save`·`/save-vr`·`/save-vr-history` → 410 폐기. 문서/CLAUDE.md 갱신. ✅

### 구현 완료 — 파일 구성
- `db.js` 연결·스키마 / `sheet.js` 파싱·계산 포팅 / `store.js` 데이터접근·낙관적잠금 / `api.js` `/api/*` 라우터·SSE / `gitsync.js` git 브리지 / `scripts/migrate-to-db.js` 마이그레이션
- 런타임: Homebrew Node 20.20.2(`~/.local/bin/node` 재연결) + better-sqlite3 임베디드. launchd `com.homi.serve` 단일 프로세스.

### 알려진 후속 과제 (선택)
- **영수증 임포트**(`/save-expense-items`, `/analyze-receipt`)와 **AI 리포트**(`summary.json`)는 여전히 **파일에 직접 쓰고** git 커밋. budget 시트가 DB-authoritative이므로, 이 파일 쓰기는 `gitsync` **import 브리지가 DB로 흡수**(정상 동작). 단, 영수증 임포트가 2026.csv를 직접 고칠 때 DB export(5s 디바운스)와 **드문 race** 가능 → 완전 정합을 원하면 영수증 임포트도 DB 경유로 전환 권장.
- **expense_detail / summary**: 현재 대시보드는 파일에서 읽음(DB엔 미러 존재). 필요 시 `/api/expense`·`/api/summary`로 읽기 전환 가능(엔드포인트 준비됨).
- 마이그레이션 시 VR `version`이 재실행 후 리셋되지 않음(단조 증가) — 기능 무영향.

각 단계는 이전 단계 위에서 **기존 파일 기반 경로와 병행 동작**하다가 P6에서 정리 → 언제든 롤백 가능.

---

## 8. 리스크 & 가드

- **실거래·실데이터**: 마이그레이션 전 전체 백업 커밋. round-trip 검증 실패 시 중단.
- **CI 충돌**: CI는 파일만 만지므로 무영향. import 브리지가 흡수. (P5 전까지 CI 결과는 기존처럼 파일로 반영되고 대시보드도 파일 fallback 유지.)
- **비밀정보**: `credentials.json`/`token.json`/`*.db`는 절대 커밋 금지(.gitignore 확인).
- **launchd 재시작**: 스키마 변경은 init 시 마이그레이션 가드로 안전 적용.
- **바이너리 DB 유실 대비**: git의 export 파일에서 언제든 재-import 가능(단일 진실원은 DB지만 복구원은 git).

---

## 9. 미해결/확인 필요 (기본값으로 진행하되 veto 가능)
1. DB 엔진 `better-sqlite3` (기본). — 네이티브 빌드 필요, node@`~/.local/bin/node`.
2. SSE 실시간 브로드캐스트 포함(기본 포함). 제외하면 저장 안정성은 같고 "타 탭 자동갱신"만 빠짐.
3. `processed_statements.json`(C등급) 이관 여부 — 기본: **후순위(P6 이후 선택)**.
4. 직전 복구한 `2026.csv` 6월 병합분 커밋 시점 — 마이그레이션 시드로 자동 포함됨.
</content>
</invoke>
