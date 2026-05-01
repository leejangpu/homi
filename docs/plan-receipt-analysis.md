# 영수증 파일 첨부 AI 분석 기능 구현 계획

## 개요

가계부 웹페이지(`financial/index.html`)에 카드 명세서(PDF/이미지) 첨부 및 AI 자동 분석 기능 추가.

---

## 1. 전체 아키텍처

### 데이터 흐름

```
[사용자]
  │ PDF/이미지 파일 선택
  ▼
[index.html — 지출 시트 상단 파일첨부 버튼]
  │ POST http://localhost:3456/api/analyze-receipt
  │ (multipart/form-data: file + year + month + password)
  ▼
[server/api.js — 로컬 Express 서버]
  │ 임시 파일 저장 (server/tmp/)
  │ Claude CLI 실행: claude -p --model claude-sonnet-4-6 --bare
  ▼
[Claude CLI (sonnet 모델)]
  │ 분석 결과: JSON (날짜, 가맹점, 금액, 카테고리, 카드)
  ▼
[server/api.js — 분석 결과 반환]
  │ → 클라이언트에 미리보기 데이터 응답
  ▼
[index.html — 결과 미리보기 모달]
  │ 항목 확인 및 수정 → "적용 및 저장" 버튼
  ▼
[POST /api/apply-receipt]
  │ 1. expense_detail.json 업데이트
  │ 2. 2026.csv 업데이트 (해당 월 변동지출)
  │ 3. git commit + push
  ▼
[POST /api/generate-report] (비동기)
  │ generate-report.sh 실행 → summary.json 업데이트
  ▼
[GitHub Pages 갱신 후 대시보드 리렌더링]
```

### 핵심 설계 원칙

- **로컬 API 서버 필수**: Claude CLI 실행/파일 시스템 접근은 `server/api.js`에서만 수행. GitHub Pages에서 `http://localhost:3456`으로 직접 호출.
- **결과 미리보기 우선**: Claude 분석 결과를 사용자가 확인/수정 후 적용하는 2단계 구조.
- **expense_detail.json이 단일 진실 공급원**: CSV의 변동지출은 expense_detail.json 카테고리별 합계로 재계산하여 동기화.
- **분석과 저장 분리**: 영수증 분석 → 즉시 미리보기 반환 / 리포트 생성 → 별도 비동기 요청.

---

## 2. 단계별 구현 순서

| 단계 | 내용 | 주요 파일 |
|------|------|-----------|
| 1단계 | 로컬 API — 파일 업로드 및 Claude 분석 엔드포인트 | `server/api.js` |
| 2단계 | Claude CLI 프롬프트 설계 및 결과 파싱 | `server/api.js` 내부 로직 |
| 3단계 | expense_detail.json + CSV 업데이트 로직 | `server/api.js` 내부 로직 |
| 4단계 | index.html UI (파일첨부 버튼 + 결과 미리보기 모달) | `financial/index.html` |
| 5단계 | AI 리포트 자동 생성 연결 및 전체 테스트 | `server/api.js`, `generate-report.sh` |

---

## 3. 단계별 구현 상세

### 1단계: 로컬 API — 파일 업로드 엔드포인트

**`server/api.js` 변경 내용:**
- `multer` 패키지 추가 (multipart 파일 업로드 처리)
- `POST /api/analyze-receipt` 엔드포인트 추가
  - 요청: `file` (PDF/이미지), `year`, `month`
  - 업로드된 파일을 `server/tmp/`에 임시 저장
  - Claude CLI 실행 후 임시 파일 삭제
  - 응답: 분석된 항목 JSON 배열 (미리보기용)
- `POST /api/apply-receipt` 엔드포인트 추가
  - 요청: 확정된 항목 배열 + year/month
  - expense_detail.json 업데이트 + CSV 업데이트 + git push
- `POST /api/generate-report` 엔드포인트 추가 (리포트 생성 분리)

**의존성 추가 (`server/package.json`):**
- `multer`: 파일 업로드 처리

**파일 크기/형식 제한:**
- 최대 20MB
- 지원 형식: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.webp`

---

### 2단계: Claude CLI 프롬프트 및 결과 파싱

**Claude CLI 호출 방식:**
```
claude -p --model claude-sonnet-4-6 --bare "프롬프트 텍스트" 파일경로
```

> 참고: Claude CLI의 파일 인자 지원 방식 사전 확인 필요. 미지원 시:
> - 이미지: Base64 인코딩하여 프롬프트에 포함
> - PDF: `pdf-parse` 패키지로 텍스트 추출 후 텍스트만 전달

**프롬프트 핵심 요소:**
1. 정해진 카테고리 목록 명시 (반드시 이 중 하나 선택)
2. 반환 형식: 엄격한 JSON 배열만 (마크다운 없이)
3. 취소/환불/포인트 적립 항목 제외 지시

**지출 카테고리 목록 (고정):**
```
외식/카페, 생활비, 쇼핑, 통신비, 관리비, 유류비, 콘텐츠,
의료, 교통, 경조사비, 여가/레저, 제외
```

**응답 형식:**
```json
{
  "month": "05",
  "items": [
    {
      "날짜": "05.03",
      "가맹점": "스타벅스",
      "카드": "삼성카드",
      "금액": 8500,
      "카테고리": "외식/카페"
    }
  ]
}
```

**검증 로직:**
- 정의된 카테고리 외 값 → "기타"로 대체 후 경고
- 단일 항목 500만원 초과 시 경고 플래그

---

### 3단계: expense_detail.json + CSV 업데이트

**expense_detail.json 업데이트:**
1. 기존 파일 읽기 → 해당 연도/월 항목 확인
2. 새 items를 추가 (기존 항목 보존, `source` 필드로 중복 추적)
3. 카테고리별 합계 재계산 (`제외` 카테고리 제외)
4. `메모` 필드: 파일명 + 분석 일시 기록

**CSV 업데이트:**
1. CSV 파싱 (BOM 제거, 행 배열 변환)
2. 기존 `splitSections()` 로직을 Node.js로 이식하여 변동지출 섹션 파악
3. expense_detail.json 카테고리별 합계를 기준으로 해당 월 변동지출 행 갱신
4. 카테고리 합계 행 및 잔액 행 재계산
5. CSV 직렬화 후 저장 (BOM 포함)

**Git 커밋:**
```
git add financial/expense_detail.json financial/2026.csv
git commit -m "영수증 분석: {year}년 {month}월 지출 업데이트"
git push
```

**주의사항:**
- 동시 요청 방지를 위한 간단한 락(lock) 플래그 필요
- 금액 포맷: `1,234,567` 형식과 `₩` 기호 처리

---

### 4단계: index.html UI 구현

**파일첨부 버튼:**
- expense 섹션 시트 상단 툴바에만 표시
- 로컬 API 연결 여부에 따라 활성/비활성 상태 자동 전환
- 연결 상태 표시 텍스트 ("로컬 서버 연결됨" / "로컬 서버 미연결")

**로컬 API 연결 감지 (`init()` 함수):**
```javascript
const LOCAL_API_URL = 'http://localhost:3456';
// init() 시 GET /api/health 호출 → 성공 시 버튼 활성화
```

**파일 업로드 모달:**
- `<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp">` 숨김 요소
- 선택한 연도/월 정보 표시
- "분석 시작" 클릭 → FormData 전송 + 로딩 스피너

**결과 미리보기 모달:**
- 추출된 항목 테이블 (날짜, 가맹점, 카드, 금액, 카테고리)
- 인라인 편집 가능 (카테고리는 드롭다운 선택)
- 제외 항목 체크박스
- "적용 및 저장" 버튼

**CSS:**
- 기존 `gh-modal-overlay` / `gh-modal` 스타일 재사용
- z-index 충돌 주의 (jSpreadsheet 위에 표시)

---

### 5단계: AI 리포트 자동 생성 연결

**연동 방식:**
- `POST /api/apply-receipt` 완료 후 클라이언트가 `POST /api/generate-report` 호출
- 서버는 `generate-report.sh {year} {month}` 실행 (타임아웃 120초)
- 완료 후 summary.json 갱신된 내용을 응답에 포함
- 클라이언트: `aiSummaries` 객체 갱신 후 대시보드 리렌더링

---

## 4. 파일별 변경/추가 목록

### 수정 파일

| 파일 | 변경 내용 |
|------|----------|
| `server/api.js` | analyze-receipt, apply-receipt, generate-report 엔드포인트 추가; CSV/JSON 업데이트 헬퍼 추가 |
| `server/package.json` | `multer` 의존성 추가 |
| `financial/index.html` | 파일첨부 버튼, 업로드 모달, 결과 미리보기 모달 UI 추가; 로컬 API 연결 감지 로직 추가 |

### 추가 파일

| 파일 | 내용 |
|------|------|
| `server/tmp/.gitkeep` | 임시 파일 저장 디렉토리 (`.gitignore`에 `server/tmp/*` 추가) |

### 런타임 업데이트 대상 (코드 변경 없음)

- `financial/2026.csv`
- `financial/expense_detail.json`
- `financial/summary.json`

---

## 5. 예상 이슈 및 해결 방법

### 이슈 1: Claude CLI 파일 첨부 방식

**문제:** Claude CLI가 PDF/이미지를 받는 방식이 버전마다 다를 수 있음.

**해결:**
- 먼저 `claude --help`로 파일 입력 옵션 확인
- 미지원 시: 이미지는 Base64 인코딩 / PDF는 `pdf-parse`로 텍스트 추출 후 전달

---

### 이슈 2: CORS (GitHub Pages → localhost HTTP 호출)

**문제:** HTTPS 페이지에서 HTTP localhost 호출 시 Mixed Content 차단 가능.

**해결:**
- 개인용 도구이므로 브라우저 설정으로 해결:
  - Chrome: `chrome://flags/#allow-insecure-localhost` 활성화
- 또는 로컬 서버에 자체 서명 인증서 적용 (HTTPS 서빙)

---

### 이슈 3: CSV 행 구조의 복잡성

**문제:** `2026.csv`의 소득/저축/지출/자산 혼합 구조에서 카테고리 행 위치를 동적으로 파악해야 함.

**해결:** 기존 `splitSections()` JavaScript 함수의 파싱 로직을 Node.js로 동일하게 이식.

---

### 이슈 4: 중복 업로드로 인한 금액 중복 합산

**문제:** 동일 월에 여러 번 영수증을 업로드하면 금액이 중복 합산될 위험.

**해결:**
- expense_detail.json items에 `source` 필드(파일명 + 타임스탬프) 저장
- CSV는 expense_detail.json 카테고리별 합계를 단일 진실 공급원으로 사용 → 항상 재계산 방식으로 동기화

---

### 이슈 5: 리포트 생성 시간 초과

**문제:** Claude CLI를 두 번 호출(분석 + 리포트)하면 총 1~2분 소요 가능.

**해결:** 분석과 리포트 생성을 별도 엔드포인트로 분리하여 클라이언트 타임아웃 방지.

---

## 6. 구현 우선순위

1. `server/api.js` — `/api/analyze-receipt` 엔드포인트 (Claude CLI 연동 포함)
2. `server/api.js` — `/api/apply-receipt` 엔드포인트 (expense_detail.json + CSV 업데이트)
3. `financial/index.html` — 파일첨부 버튼 + 미리보기 모달 UI
4. `server/api.js` — `/api/generate-report` 엔드포인트 + index.html 연동
5. 전체 테스트 (PDF, 이미지 각각)
