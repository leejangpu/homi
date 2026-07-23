#!/bin/bash
# launchd 래퍼: 떨사오팔 장 마감 후 체결 반영 + 다음날 계획

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR" "$SCRIPT_DIR/state"
LOG_FILE="$LOG_DIR/close.log"

echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "▶ main-close at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE"

if [ -f "$SCRIPT_DIR/.env" ]; then set -a; source "$SCRIPT_DIR/.env"; set +a; fi

npm install --silent >> "$LOG_FILE" 2>&1
npx tsx src/main-close.ts >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "▶ exit $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE"

cd "$REPO_ROOT"
git config user.name "ddsaopal-bot"
git config user.email "bot@ddsaopal.local"
git add ddsaopal/state ddsaopal/config.json >> "$LOG_FILE" 2>&1
if ! git diff --staged --quiet; then
    git commit -m "ddsaopal: close $(date '+%Y-%m-%d')" >> "$LOG_FILE" 2>&1
    git pull --rebase >> "$LOG_FILE" 2>&1
    git push >> "$LOG_FILE" 2>&1
fi
exit $EXIT_CODE
