#!/bin/bash
# launchd에서 실행할 무한매수법 장 오픈 래퍼 스크립트

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR" "$SCRIPT_DIR/state" "$SCRIPT_DIR/history"
LOG_FILE="$LOG_DIR/open.log"

echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "▶ Starting main-open.ts at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

# .env 로드
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# 의존성 설치
npm install --silent >> "$LOG_FILE" 2>&1

# 실행
npx tsx src/main-open.ts >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "▶ Finished with exit code: $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE"

# state 변경사항 커밋 & 푸시 (repo 루트에서 실행)
cd "$REPO_ROOT"
git config user.name "infinite-buy-bot"
git config user.email "bot@infinite-buy.local"

# 변경된 파일만 add (존재하는 것만)
for dir in infinite-buy/state infinite-buy/logs infinite-buy/history; do
    if [ -d "$dir" ]; then
        git add "$dir/" >> "$LOG_FILE" 2>&1
    fi
done
git add infinite-buy/config.json >> "$LOG_FILE" 2>&1

if ! git diff --staged --quiet; then
    git commit -m "infinite-buy: open orders $(date '+%Y-%m-%d')" >> "$LOG_FILE" 2>&1
    git pull --rebase >> "$LOG_FILE" 2>&1
    git push >> "$LOG_FILE" 2>&1
    echo "▶ Git commit & push 완료" >> "$LOG_FILE"
else
    echo "▶ 변경사항 없음, 커밋 스킵" >> "$LOG_FILE"
fi

exit $EXIT_CODE
