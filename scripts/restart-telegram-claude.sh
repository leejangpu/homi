#!/bin/bash
# Claude Code 텔레그램 세션 강제 재시작 (킬스위치)
# 사용: ./scripts/restart-telegram-claude.sh [--fresh]
#   --fresh: 세션 정보 파일도 삭제하여 --continue 없이 새 세션으로 시작

ENV="/Users/mac_ad03249840/Developer/homi/infinite-buy/.env"
SESSION_INFO_FILE="/tmp/homi-tg-session-info"
LABEL="com.homi.telegram-claude"
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_CHAT_ID=' "$ENV" | cut -d= -f2-)

send_msg() {
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" > /dev/null
}

FRESH=false
if [ "$1" = "--fresh" ]; then
  FRESH=true
fi

echo "[$(date '+%H:%M:%S')] 텔레그램 클로드 재시작 시작 (fresh=${FRESH})"

# 1. 현재 프로세스 강제 종료
PIDS=$(pgrep -f "claude.*plugin:telegram" 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "  종료 대상 PID: $PIDS"
  pkill -9 -f "claude.*plugin:telegram"
  sleep 1
fi

# 2. 세션 wrapper script 도 정리
pkill -9 -f "start-telegram-claude.sh" 2>/dev/null

# 3. fresh 모드면 세션 정보 삭제
if [ "$FRESH" = "true" ]; then
  rm -f "$SESSION_INFO_FILE"
  echo "  세션 정보 삭제 → 새 대화로 시작"
fi

# 4. launchd 재시작 (kickstart -k: 죽이고 다시 띄움)
UID_NUM=$(id -u)
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
EXIT=$?

if [ $EXIT -eq 0 ]; then
  echo "[$(date '+%H:%M:%S')] launchd kickstart 성공"
  if [ "$FRESH" = "true" ]; then
    send_msg "🔄 텔레그램 클로드 강제 재시작 (fresh, $(date '+%H:%M'))"
  else
    send_msg "🔄 텔레그램 클로드 강제 재시작 ($(date '+%H:%M'))"
  fi
else
  echo "[$(date '+%H:%M:%S')] launchd kickstart 실패 (exit=$EXIT)"
  send_msg "⚠️ 텔레그램 클로드 재시작 실패 ($(date '+%H:%M'), launchctl exit=$EXIT)"
  exit $EXIT
fi
