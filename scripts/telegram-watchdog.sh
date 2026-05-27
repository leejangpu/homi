#!/bin/bash
# Claude Code 텔레그램 플러그인 연결 감시
# - 활성 중: 세션 ID와 활동 시각을 파일에 저장 (재시작 시 resume에 활용)
# - 끊김: Bot API로 직접 알림 전송 (launchd가 자동 재시작)

ENV="/Users/mac_ad03249840/Developer/homi/infinite-buy/.env"
SESSION_DIR="/Users/mac_ad03249840/.claude/projects/-Users-mac-ad03249840-Developer-homi"
SESSION_INFO_FILE="/tmp/homi-tg-session-info"
ALERT_STAMP_FILE="/tmp/homi-tg-watchdog-alerted"

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_CHAT_ID=' "$ENV" | cut -d= -f2-)

send_msg() {
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" > /dev/null
}

# claude --channels plugin:telegram 프로세스 확인
# 여러 개 떠 있을 수 있으므로 본체 + MCP 자식이 모두 살아있는 "정상" 세션이 하나라도 있는지 검사
# (좀비: claude 본체는 살아있지만 bun MCP 자식이 죽은 상태 → reply 도구 불가)
NOW=$(date +%s)
ALL_PIDS=$(pgrep -f "claude.*plugin:telegram" 2>/dev/null)
HEALTHY_PID=""
ZOMBIE_PIDS=""
for pid in $ALL_PIDS; do
  # 자기 자신과 동일한 cmdline 일 수 있는 script 래퍼는 제외 (PPID=1, claude 본체만 검사)
  CMD=$(ps -p "$pid" -o command= 2>/dev/null)
  case "$CMD" in
    *"/usr/bin/script"*) continue ;;
  esac
  MCP_PID=$(pgrep -P "$pid" -f bun 2>/dev/null | head -1)
  if [ -n "$MCP_PID" ]; then
    HEALTHY_PID="$pid"
  else
    ZOMBIE_PIDS="$ZOMBIE_PIDS $pid"
  fi
done

# 좀비가 있으면 즉시 종료 (launchd가 재시작)
if [ -n "$ZOMBIE_PIDS" ]; then
  if [ -f "$ALERT_STAMP_FILE" ]; then
    LAST=$(cat "$ALERT_STAMP_FILE")
    if [ $((NOW - LAST)) -lt 600 ]; then
      exit 0
    fi
  fi
  echo "$NOW" > "$ALERT_STAMP_FILE"
  send_msg "⚠️ Claude Code 텔레그램 MCP 끊김 감지 ($(date '+%H:%M'))
좀비 PID:${ZOMBIE_PIDS} (본체는 살아있지만 bun MCP 자식 없음)
좀비 종료 → launchd 자동 재시작 대기..."
  for zp in $ZOMBIE_PIDS; do
    kill -9 "$zp" 2>/dev/null
  done
  exit 0
fi

CLAUDE_PID="$HEALTHY_PID"
if [ -n "$CLAUDE_PID" ]; then

  # 프로세스 시작 시각 (epoch) 계산
  PROC_LSTART=$(ps -p "$CLAUDE_PID" -o lstart= 2>/dev/null | sed 's/^ *//')
  PROC_START_EPOCH=0
  if [ -n "$PROC_LSTART" ]; then
    PROC_START_EPOCH=$(date -j -f "%a %b %d %H:%M:%S %Y" "$PROC_LSTART" +%s 2>/dev/null || echo 0)
  fi
  PROC_AGE=$((NOW - PROC_START_EPOCH))

  # 현재 프로세스에 속한 jsonl 찾기 (mod 시각이 프로세스 시작 이후인 것)
  # 새 세션은 첫 메시지가 오기 전까지 jsonl 파일을 만들지 않으므로,
  # 못 찾으면 PROC_START 를 활동 기준 시각으로 사용 (idle 새 세션 오탐 방지)
  LATEST=""
  LATEST_MOD=0
  for f in $(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null); do
    MOD=$(stat -f %m "$f" 2>/dev/null || echo 0)
    if [ "$MOD" -ge "$PROC_START_EPOCH" ]; then
      LATEST=$f
      LATEST_MOD=$MOD
      break
    fi
  done

  if [ -n "$LATEST" ]; then
    SESSION_ID=$(basename "$LATEST" .jsonl)
    printf '%s\n%s\n' "$SESSION_ID" "$LATEST_MOD" > "$SESSION_INFO_FILE"
  else
    LATEST_MOD=$PROC_START_EPOCH
  fi

  # 3시간 무대화 시 세션 클리어 (kill → launchd가 새 세션으로 재시작)
  # 단, 이번 세션에서 한 번도 대화가 없었다면(이전 클리어 직후 재시작된 빈 세션)
  # 메시지 없이 조용히 클리어
  IDLE=$((NOW - LATEST_MOD))
  if [ "$IDLE" -gt 10800 ]; then
    if [ -n "$LATEST" ]; then
      send_msg "🔄 ${IDLE}초 무대화로 세션 자동 클리어 ($(date '+%H:%M'))"
    fi
    pkill -f "claude.*plugin:telegram"
    exit 0
  fi

  # 이전에 끊김 알림을 보냈다면 복구 알림 전송
  if [ -f "$ALERT_STAMP_FILE" ]; then
    rm -f "$ALERT_STAMP_FILE"
    send_msg "✅ Claude Code 텔레그램 연결 복구됨 ($(date '+%H:%M'))
launchd가 자동 재시작했습니다."
  fi
  exit 0
fi

# 끊김 감지: 10분마다 한 번만 알림 (스팸 방지)
NOW=$(date +%s)
if [ -f "$ALERT_STAMP_FILE" ]; then
  LAST=$(cat "$ALERT_STAMP_FILE")
  DIFF=$((NOW - LAST))
  if [ $DIFF -lt 600 ]; then
    exit 0
  fi
fi

echo "$NOW" > "$ALERT_STAMP_FILE"
send_msg "⚠️ Claude Code 텔레그램 연결 끊김 ($(date '+%H:%M'))
launchd가 30초 내 자동 재시작 중입니다..."
