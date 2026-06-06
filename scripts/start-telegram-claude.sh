#!/bin/bash
# Claude Code 텔레그램 세션 시작 래퍼
# launchd 백그라운드에서 TTY 없이 실행 시 script 로 가상 TTY 제공
# - 3시간 이내 활동 기록 있음: --continue 로 이전 대화 복원
# - 3시간 초과 또는 기록 없음: 새 세션 시작

SESSION_INFO_FILE="/tmp/homi-tg-session-info"
GREETED_STAMP_FILE="/tmp/homi-tg-greeted"
SESSION_DIR="/Users/mac_ad03249840/.claude/projects/-Users-mac-ad03249840-Developer-homi"
THREE_HOURS=10800
# --continue 시 "Resume from summary" 확인 모달이 뜨는 임계 (대략 113k 토큰 ≈ 550KB)
# 모달은 TTY 없는 launchd 환경에서 영원히 멈춤 → 임계 초과면 새 세션으로 시작
JSONL_SIZE_LIMIT=350000
CLAUDE=/opt/homebrew/bin/claude
ENV="/Users/mac_ad03249840/Developer/homi/infinite-buy/.env"
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_CHAT_ID=' "$ENV" | cut -d= -f2-)

send_msg() {
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" > /dev/null
}

# 직전에 보낸 인사 이후로 사용자 활동(jsonl mod)이 없었으면 true
greeted_without_activity() {
  [ -f "$GREETED_STAMP_FILE" ] || return 1
  local greeted last
  greeted=$(cat "$GREETED_STAMP_FILE" 2>/dev/null)
  [ -n "$greeted" ] || return 1
  if [ -f "$SESSION_INFO_FILE" ]; then
    last=$(sed -n '2p' "$SESSION_INFO_FILE")
    [ -n "$last" ] || last=0
  else
    last=0
  fi
  [ "$greeted" -ge "$last" ]
}

greet() {
  if greeted_without_activity; then
    echo "[$(date '+%H:%M:%S')] 인사 생략 (직전 인사 이후 사용자 활동 없음)"
    return
  fi
  send_msg "$1"
  date +%s > "$GREETED_STAMP_FILE"
}

run_claude() {
  # TTY 없는 환경(launchd)이면 script 로 가상 TTY 제공
  if [ -t 0 ]; then
    exec "$CLAUDE" $@
  else
    exec /usr/bin/script -q /dev/null "$CLAUDE" $@
  fi
}

SHOULD_CONTINUE=false
if [ -f "$SESSION_INFO_FILE" ]; then
  LAST_ACTIVE=$(sed -n '2p' "$SESSION_INFO_FILE")
  NOW=$(date +%s)
  DIFF=$((NOW - LAST_ACTIVE))

  if [ "$DIFF" -lt "$THREE_HOURS" ]; then
    LATEST_JSONL=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
    JSONL_SIZE=0
    if [ -n "$LATEST_JSONL" ]; then
      JSONL_SIZE=$(stat -f %z "$LATEST_JSONL" 2>/dev/null || echo 0)
    fi

    if [ "$JSONL_SIZE" -gt "$JSONL_SIZE_LIMIT" ]; then
      echo "[$(date '+%H:%M:%S')] 세션 크기 ${JSONL_SIZE}B > ${JSONL_SIZE_LIMIT}B — 모달 회피 위해 새 세션 시작"
      greet "🆕 새 세션 시작 ($(date '+%H:%M'), 이전 세션 ${JSONL_SIZE}B로 너무 커서 --continue 생략)"
    else
      SHOULD_CONTINUE=true
      echo "[$(date '+%H:%M:%S')] 세션 복원 (--continue, ${DIFF}초 전 활동, ${JSONL_SIZE}B)"
      send_msg "✅ 세션 복원 완료 ($(date '+%H:%M'), ${DIFF}초 전 대화 이어서)"
    fi
  else
    echo "[$(date '+%H:%M:%S')] 새 세션 시작 (마지막 활동 ${DIFF}초 전 — 3시간 초과)"
    greet "🆕 새 세션 시작 ($(date '+%H:%M'), 이전 대화 3시간 초과)"
  fi
else
  echo "[$(date '+%H:%M:%S')] 새 세션 시작"
  greet "🆕 새 세션 시작 ($(date '+%H:%M'))"
fi

if [ "$SHOULD_CONTINUE" = "true" ]; then
  run_claude --dangerously-skip-permissions \
    --channels plugin:telegram@claude-plugins-official \
    --continue
  echo "[$(date '+%H:%M:%S')] --continue 실패, 새 세션으로 재시작"
  send_msg "⚠️ 세션 복원 실패 ($(date '+%H:%M')), 새 대화로 시작합니다"
fi

run_claude --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official
