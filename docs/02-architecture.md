# Architecture

## 1. 기술 스택
- Frontend: Next.js (App Router) + TypeScript
- 인증: Firebase Authentication
- 서버 로직: Cloud Functions for Firebase
- 데이터 저장: git 기반 파일 관리 (JSON/CSV)

## 2. 상위 구조
1. 클라이언트(Next.js)
- 로그인/대시보드/모듈 UI

2. Firebase Auth
- 사용자 식별 (UID 기반)

3. Cloud Functions
- Telegram + Gemini 연동
- AI 액션 게이트웨이

4. 데이터 저장소
- git 리포지토리 내 파일 기반 관리

## 3. 권한 모델
- 기본 단위: `space` (개인 또는 공유)
- 각 모듈은 반드시 하나의 `space`에 소속
- 사용자 권한:
  - `owner`: 공간 및 모듈 전체 관리
  - `editor`: 데이터 읽기/쓰기
  - `viewer`: 읽기 전용

## 4. 멀티 인스턴스 모듈 전략
- 모듈은 타입 + 인스턴스로 구분
  - 예: `ledger` 타입 모듈 3개 생성 가능
- 각 인스턴스는 별도 설정과 별도 데이터를 가진다.

## 5. 데이터 흐름
1. 사용자가 모듈에 데이터 입력
2. 데이터를 파일로 저장 (git 관리)
3. 통계/집계는 데이터 파일 기반으로 생성
4. UI는 데이터 파일을 읽어 차트/리포트 표시

## 6. AI 확장 포인트
- Function endpoint: `aiCommand`
- 입력: 자연어 명령 + 사용자 컨텍스트
- 원칙: AI도 기존 권한 모델을 우회하지 못함
