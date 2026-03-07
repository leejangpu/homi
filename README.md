# Homi - Family Personal Web App

이 저장소는 2인 가족(확장 가능)을 위한 퍼스널 웹앱 프로젝트입니다.

## 구현 현황
- Next.js + TypeScript 앱 구조
- Firebase Auth 기반 Google 로그인
- Firebase Functions (Telegram + Gemini 연동)

## 빠른 시작
1. 의존성 설치
```bash
npm install
```

2. 환경 변수 설정
```bash
cp .env.example .env.local
```
`.env.local`에 Firebase 웹앱 키를 입력합니다.

3. 로컬 실행
```bash
npm run dev
```

## Telegram + Gemini 연동
Firebase Functions HTTP endpoint(`telegramWebhook`)가 Telegram webhook 업데이트를 받아 Gemini API로 전달하고, 응답을 같은 채팅에 답글로 보내는 흐름이 포함되어 있습니다.

1. BotFather 설정
- BotFather에서 봇을 만들고 `TELEGRAM_BOT_TOKEN`을 발급받습니다.
- 그룹의 모든 메시지를 받고 싶으면 BotFather `setprivacy`를 `Disable`로 설정합니다.

2. Functions 환경 변수 설정
- `functions/.env.example`을 참고해서 `functions/.env` 파일을 생성합니다.

3. Functions 배포
```bash
npm run firebase:deploy:functions
```

4. webhook 등록
```bash
npm run telegram:webhook:set
```

5. webhook 상태 확인
```bash
npm run telegram:webhook:info
```

## 주요 경로
- 요구사항: `docs/01-prd.md`
- 아키텍처: `docs/02-architecture.md`
- MVP 로드맵: `docs/04-mvp-roadmap.md`
