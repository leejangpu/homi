# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 언어

모든 답변은 한국어로 작성합니다.

## 프로젝트 개요

Homi는 가족용 퍼스널 웹앱입니다. 세 가지 주요 서브시스템으로 구성됩니다:

1. **Next.js 프론트엔드** (`src/`) — React 19 + TypeScript, Firebase Auth 기반 Google 로그인
2. **텔레그램 봇 서버** (`server/`) — Node.js 폴링 방식, Gemini AI 연동, 카드 명세서(xlsx) 파싱 → GitHub CSV 저장
3. **로또 자동구매** (`lotto/`) — Python + Playwright 브라우저 자동화, cron 스케줄

`functions/` 디렉토리는 Firebase Cloud Functions 기반 웹훅 구현으로 **deprecated** 상태입니다. 현재 운영은 `server/`에서 로컬 폴링 방식으로 동작합니다.

## 주요 명령어

### Next.js 프론트엔드
```bash
npm install              # 의존성 설치
npm run dev              # 개발 서버 (port 3100)
npm run build            # 프로덕션 빌드
npm run lint             # ESLint
npm run typecheck        # TypeScript 타입 검사
```

### 텔레그램 봇 서버
```bash
cd server && npm install  # 의존성 설치
cd server && npm start    # 서버 실행 (node index.js)
```
환경 변수: `server/.env` (Gemini API 키, 텔레그램 봇 토큰, GitHub 토큰)

### 로또 자동구매
```bash
cd lotto
source .venv/bin/activate
python main.py                    # 기본 실행 (자동 번호)
python main.py --manual 1,2,3,4,5,6  # 수동 번호 지정
```
환경 변수: `lotto/.env` (로또 사이트 계정, 텔레그램 알림)

## 아키텍처 핵심

- **텔레그램 봇 메시지 흐름**: Telegram getUpdates(폴링) → `server/index.js` handleMessage() → xlsx 감지 시 Gemini로 파싱 후 GitHub CSV 저장 / 일반 메시지는 Gemini 대화 응답
- **가계부 데이터**: 카드 명세서 xlsx → Gemini AI가 JSON으로 파싱 (날짜, 카테고리, 금액 등) → `가계부/` 디렉토리에 CSV로 GitHub API를 통해 커밋
- **대화 히스토리**: 메모리 기반, 1시간 TTL
- **인증**: 프론트엔드는 Firebase Auth (`src/lib/auth-context.tsx`), 서버는 Google OAuth2 (`server/auth.js`)

## 기술 스택 참고

- TypeScript 경로 별칭: `@/*` → `./src/*`
- Node.js 20, Python 3.11
- 패키지 매니저: npm (Node), pip + venv (Python)
- 테스트 프레임워크 미설정
