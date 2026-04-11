# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 언어

모든 답변은 한국어로 작성합니다.

## 프로젝트 개요

Homi는 가족용 퍼스널 자동화 프로젝트입니다. 네 가지 주요 서브시스템으로 구성됩니다:

1. **가계부 대시보드** (`financial/`) — GitHub Pages 정적 사이트, 순수 HTML/JS (ECharts + jSpreadsheet)
2. **텔레그램 봇 서버** (`server/`) — Node.js 폴링 방식, Gemini AI 연동, 카드 명세서(xlsx) 파싱 → GitHub CSV 저장
3. **로또 자동구매** (`lotto/`) — Python + Playwright 브라우저 자동화, macOS launchd 스케줄
4. **무한매수법 자동매매** (`infinite-buy/`) — TypeScript, 한국투자증권 API, GitHub Actions self-hosted runner

> **상세 아키텍처**: `docs/02-architecture.md` 참고

## 주요 명령어

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
환경 변수: `infinite-buy/.env` (KIS API 키, 텔레그램 알림)
스케줄: GitHub Actions (`infinite-buy-open.yml`, `infinite-buy-close.yml`)

## 아키텍처 핵심

- **가계부 웹**: GitHub Pages (`https://leejangpu.github.io/homi/financial/`) — `financial/index.html`이 CSV를 fetch하여 차트/테이블 렌더링
- **텔레그램 봇 흐름**: Telegram getUpdates(폴링) → `server/index.js` → xlsx 감지 시 Gemini 파싱 → GitHub CSV 커밋 / 일반 메시지는 Gemini 대화 응답
- **가계부 데이터**: 카드 명세서 xlsx → Gemini AI 파싱 → `가계부/` CSV로 GitHub API 커밋 → `financial/index.html`에서 표시
- **데이터 저장**: CSV/JSON 파일 (git 관리), 별도 DB 없음

## 기술 스택

- Node.js 20, Python 3.11
- 패키지 매니저: npm (Node), pip + venv (Python)
- 자동화: macOS launchd (로또), GitHub Actions self-hosted runner (무한매수법)
- 배포: GitHub Pages (financial), 로컬 실행 (server, lotto)
- 테스트 프레임워크 미설정
