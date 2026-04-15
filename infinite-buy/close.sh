#!/bin/bash
# launchd에서 실행할 무한매수법 장 마감 래퍼 스크립트

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/close.log"

echo "▶ Starting main-close.ts at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE" 2>&1

# .env 로드
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# 의존성 설치
npm install --silent >> "$LOG_FILE" 2>&1

# 실행
npx tsx src/main-close.ts >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "▶ Finished with exit code: $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE" 2>&1

# state 변경사항 커밋 & 푸시
git config user.name "infinite-buy-bot"
git config user.email "bot@infinite-buy.local"
git add state/ logs/ history/ config.json 2>/dev/null
if ! git diff --staged --quiet; then
    git commit -m "infinite-buy: close sync $(date '+%Y-%m-%d')" >> "$LOG_FILE" 2>&1
    git pull --rebase >> "$LOG_FILE" 2>&1
    git push >> "$LOG_FILE" 2>&1
fi

exit $EXIT_CODE
