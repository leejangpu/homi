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

NOW=$(date +%s)

# 사용 한도 도달/회복 감지
# Claude TUI는 "You've hit your limit · resets HH:MMam/pm (Asia/Seoul)" 메시지를 표시
# - 도달 알림: 5시간 윈도우당 한 번 (date+reset 시각으로 dedup)
# - 회복 알림: stamp의 reset_epoch 지나면 한 번
# - LIMIT_ACTIVE=true 인 동안 idle 타이머 일시정지 (아래 idle 체크에서 사용)
LIMIT_LOG="/Users/mac_ad03249840/Developer/homi/logs/telegram-claude.log"
LIMIT_STAMP_FILE="/tmp/homi-tg-limit-alerted"
LIMIT_ACTIVE=false

HIT_LINE=""
if [ -f "$LIMIT_LOG" ]; then
  HIT_LINE=$(tail -c 200000 "$LIMIT_LOG" 2>/dev/null \
    | LC_ALL=C perl -pe 's/\x1b\[[0-9;?]*[A-Za-z]/ /g; s/\x1b\][^\x07]*\x07/ /g; s/[\x00-\x08\x0b-\x1f]/ /g' \
    | tr -s ' ' \
    | LC_ALL=C grep -aoE "You.{0,2}ve hit your limit.{0,40}resets [0-9]+:[0-9]+[apm]+ \(Asia/Seoul\)" \
    | tail -1)
fi

if [ -n "$HIT_LINE" ]; then
  RESET_TIME=$(echo "$HIT_LINE" | LC_ALL=C grep -oE "resets [0-9]+:[0-9]+[apm]+" | head -1)
  RESET_HMP=$(echo "$RESET_TIME" | sed -E 's/resets //')
  TODAY=$(date '+%Y-%m-%d')
  RESET_TODAY=$(date -j -f "%I:%M%p %Y-%m-%d" "${RESET_HMP} ${TODAY}" '+%s' 2>/dev/null)
  # Claude TUI는 항상 미래 시각을 reset으로 표시함.
  # RESET_TODAY 가 이미 과거면 = (a) 자정 넘는 윈도우 or (b) stale 로그 잔재
  # (a) 와 (b) 를 구분하려면: 차이가 12시간 안쪽이면 stale (한도 메시지가 화면에 남아있는 것), 12시간 이상이면 자정 넘김
  RESET_EPOCH=0
  if [ -n "$RESET_TODAY" ]; then
    if [ "$RESET_TODAY" -ge "$NOW" ]; then
      RESET_EPOCH=$RESET_TODAY
    elif [ $((NOW - RESET_TODAY)) -gt 43200 ]; then
      # 과거지만 12시간 넘게 차이 → 자정 넘김 (예: 새벽 한도면 다음 날 같은 시각)
      RESET_EPOCH=$((RESET_TODAY + 86400))
    fi
    # 그 외 (12시간 안쪽 과거) = stale → RESET_EPOCH=0 으로 두고 알림 생략
  fi

  if [ "$RESET_EPOCH" -gt 0 ]; then
    KEY="${TODAY}-${RESET_TIME}"
    LAST_KEY=""
    [ -f "$LIMIT_STAMP_FILE" ] && LAST_KEY=$(sed -n '1p' "$LIMIT_STAMP_FILE")
    if [ "$LAST_KEY" != "$KEY" ]; then
      printf '%s\n%s\n' "$KEY" "$RESET_EPOCH" > "$LIMIT_STAMP_FILE"
      send_msg "🚫 Claude 사용 한도 도달 ($(date '+%H:%M'))
${HIT_LINE}
한도 풀린 뒤 다시 메시지 보내."
    fi
  fi
fi

# 회복 감지 + 활성 플래그 갱신
if [ -f "$LIMIT_STAMP_FILE" ]; then
  STAMP_RESET_EPOCH=$(sed -n '2p' "$LIMIT_STAMP_FILE")
  if [ -n "$STAMP_RESET_EPOCH" ] && [ "$STAMP_RESET_EPOCH" -gt 0 ] && [ "$NOW" -ge "$STAMP_RESET_EPOCH" ]; then
    send_msg "✅ Claude 사용 한도 회복 ($(date '+%H:%M')) — 다시 대화 가능"
    rm -f "$LIMIT_STAMP_FILE"
  else
    LIMIT_ACTIVE=true
  fi
fi

# claude --channels plugin:telegram 프로세스 확인
# 여러 개 떠 있을 수 있으므로 본체 + MCP 자식이 모두 살아있는 "정상" 세션이 하나라도 있는지 검사
# (좀비: claude 본체는 살아있지만 bun MCP 자식이 죽은 상태 → reply 도구 불가)
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
# 알림만 10분 dedup, kill은 매 cycle 실행 — dedup이 kill까지 막으면 좀비가 그대로 방치돼
# 사용자 메시지를 못 받는 상태가 길어진다.
if [ -n "$ZOMBIE_PIDS" ]; then
  SHOULD_ALERT=true
  if [ -f "$ALERT_STAMP_FILE" ]; then
    LAST=$(cat "$ALERT_STAMP_FILE")
    if [ $((NOW - LAST)) -lt 600 ]; then
      SHOULD_ALERT=false
    fi
  fi
  if [ "$SHOULD_ALERT" = "true" ]; then
    echo "$NOW" > "$ALERT_STAMP_FILE"
    send_msg "⚠️ Claude Code 텔레그램 MCP 끊김 감지 ($(date '+%H:%M'))
좀비 PID:${ZOMBIE_PIDS} (본체는 살아있지만 bun MCP 자식 없음)
좀비 종료 → launchd 자동 재시작 대기..."
  fi
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

  # 한도 중이면 LATEST_MOD 를 NOW 로 advance → idle 타이머 일시정지
  # (대화 도중 한도 걸렸을 때 자동 세션 클리어 방지)
  if [ "$LIMIT_ACTIVE" = "true" ]; then
    LATEST_MOD=$NOW
  fi

  if [ -n "$LATEST" ]; then
    SESSION_ID=$(basename "$LATEST" .jsonl)
    printf '%s\n%s\n' "$SESSION_ID" "$LATEST_MOD" > "$SESSION_INFO_FILE"
  elif [ "$LIMIT_ACTIVE" != "true" ]; then
    LATEST_MOD=$PROC_START_EPOCH
  fi

  # 3시간 무대화 시 세션 클리어 (kill → launchd가 새 세션으로 재시작)
  # 단, 이번 세션에서 한 번도 대화가 없었다면(이전 클리어 직후 재시작된 빈 세션)
  # 메시지 없이 조용히 클리어
  IDLE=$((NOW - LATEST_MOD))
  if [ "$IDLE" -gt 10800 ] && [ "$LIMIT_ACTIVE" != "true" ]; then
    if [ -n "$LATEST" ]; then
      send_msg "🔄 ${IDLE}초 무대화로 세션 자동 클리어 ($(date '+%H:%M'))"
    fi
    # 세션 클리어 전에 워킹트리에 남은 변경이 있으면 자동 커밋·푸시
    # (-uno 로 untracked 제외, git add -u 로 tracked 수정만 스테이징)
    HOMI_DIR="/Users/mac_ad03249840/Developer/homi"
    if cd "$HOMI_DIR" 2>/dev/null && [ -n "$(git status --porcelain -uno 2>/dev/null)" ]; then
      CHANGED=$(git diff --name-only HEAD 2>/dev/null | tr '\n' ' ')
      git add -u 2>/dev/null
      if git commit -m "auto: 세션 자동 클리어 시 워킹트리 커밋 ($(date '+%Y-%m-%d %H:%M'))" >/dev/null 2>&1; then
        PUSH_OUT=$(git push 2>&1)
        PUSH_RC=$?
        if [ "$PUSH_RC" -eq 0 ]; then
          send_msg "📦 워킹트리 자동 커밋·푸시 완료
${CHANGED}"
        else
          send_msg "📦 워킹트리 자동 커밋 완료, 푸시 실패
${CHANGED}
push: ${PUSH_OUT}"
        fi
      fi
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
