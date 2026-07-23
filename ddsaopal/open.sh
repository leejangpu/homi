#!/bin/bash
# launchd 래퍼: 떨사오팔 장 개시(마감 1시간 전) 주문 제출
# 실주문 활성화: config.json enabled=true 로 바꾸고 아래 export 주석 해제
export DDSAOPAL_LIVE_ORDERS=YES_REALLY

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR" "$SCRIPT_DIR/state"
LOG_FILE="$LOG_DIR/open.log"

echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "▶ main-open at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE"

if [ -f "$SCRIPT_DIR/.env" ]; then set -a; source "$SCRIPT_DIR/.env"; set +a; fi

npm install --silent >> "$LOG_FILE" 2>&1
npx tsx src/main-open.ts >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "▶ exit $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$LOG_FILE"

# 상태 백업 커밋/푸시
cd "$REPO_ROOT"
git config user.name "ddsaopal-bot"
git config user.email "bot@ddsaopal.local"
git add ddsaopal/state ddsaopal/config.json >> "$LOG_FILE" 2>&1
if ! git diff --staged --quiet; then
    git commit -m "ddsaopal: open $(date '+%Y-%m-%d')" >> "$LOG_FILE" 2>&1
    git pull --rebase >> "$LOG_FILE" 2>&1
    git push >> "$LOG_FILE" 2>&1
fi
exit $EXIT_CODE
