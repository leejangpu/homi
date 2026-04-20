# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 언어

모든 답변은 한국어로 작성합니다.

## 프로젝트 개요

Homi는 가족용 퍼스널 자동화 프로젝트입니다. 세 가지 주요 서브시스템으로 구성됩니다:

1. **가계부 대시보드** (`financial/`) — GitHub Pages 정적 사이트, 순수 HTML/JS (ECharts + jSpreadsheet)
2. **로또 자동구매** (`lotto/`) — Python + Playwright 브라우저 자동화, macOS launchd 스케줄
3. **무한매수법 자동매매** (`infinite-buy/`) — TypeScript, 한국투자증권 API, GitHub Actions self-hosted runner

> **상세 아키텍처**: `docs/02-architecture.md` 참고

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
환경 변수: `infinite-buy/.env` (KIS API 키, 텔레그램 알림)
스케줄: GitHub Actions (`infinite-buy-open.yml`, `infinite-buy-close.yml`)

## 아키텍처 핵심

- **가계부 웹**: GitHub Pages (`https://leejangpu.github.io/homi/financial/`) — `financial/index.html`이 CSV를 fetch하여 차트/테이블 렌더링
- **AI 리포트**: `financial/generate-report.sh` → Claude CLI sonnet → `financial/summary.json` 업데이트 → git push
- **가계부 데이터**: CSV/JSON 파일 (git 관리), 별도 DB 없음
- **텔레그램 대화**: Claude Code 텔레그램 플러그인으로 직접 대화 (별도 봇 서버 없음)

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
- 자동화: macOS launchd (로또), GitHub Actions self-hosted runner (무한매수법, 리포트)
- 배포: GitHub Pages (financial), 로컬 실행 (lotto)
- 테스트 프레임워크 미설정
