#!/bin/bash
# Mac LAN IP 변경 감지 → 텔레그램 알림 + 채팅방 핀
# launchd StartInterval로 주기적 호출 (기본 1시간)
# 이전 IP는 /tmp/homi-lan-ip, 이전에 핀한 메시지 ID는 /tmp/homi-lan-ip-pin 에 저장.
# IP가 바뀌면 새 메시지를 전송한 뒤 이전 핀을 해제하고 새 메시지를 핀(silent).

ENV="/Users/mac_ad03249840/Developer/homi/infinite-buy/.env"
STATE_FILE="/tmp/homi-lan-ip"
PIN_STATE_FILE="/tmp/homi-lan-ip-pin"
PORT=3000

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_CHAT_ID=' "$ENV" | cut -d= -f2-)

# sendMessage → 새 message_id 반환 (실패 시 빈 문자열)
send_msg() {
  if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo "[$(date '+%H:%M:%S')] 텔레그램 자격 없음, 알림 스킵" >&2
    return
  fi
  local resp
  resp=$(curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1")
  echo "$resp" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print(d["result"]["message_id"] if d.get("ok") else "")
except Exception:
    print("")' 2>/dev/null
}

unpin_msg() {
  local mid="$1"
  [ -z "$mid" ] && return
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/unpinChatMessage" \
    -d "chat_id=${CHAT_ID}" -d "message_id=${mid}" > /dev/null
}

pin_msg() {
  local mid="$1"
  [ -z "$mid" ] && return
  # disable_notification=true: 핀 알림 푸시 안 띄움 (메시지 자체는 이미 푸시됨)
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/pinChatMessage" \
    -d "chat_id=${CHAT_ID}" -d "message_id=${mid}" \
    -d "disable_notification=true" > /dev/null
}

rotate_pin() {
  local new_id="$1"
  [ -z "$new_id" ] && return
  local prev_pin=""
  [ -f "$PIN_STATE_FILE" ] && prev_pin=$(cat "$PIN_STATE_FILE")
  if [ -n "$prev_pin" ] && [ "$prev_pin" != "$new_id" ]; then
    unpin_msg "$prev_pin"
  fi
  pin_msg "$new_id"
  echo "$new_id" > "$PIN_STATE_FILE"
}

# 기본 게이트웨이로 나가는 인터페이스 탐지
IFACE=$(/sbin/route -n get default 2>/dev/null | awk '/interface:/ {print $2}')
if [ -z "$IFACE" ]; then
  echo "[$(date '+%H:%M:%S')] 기본 인터페이스 없음 (네트워크 끊김?). 스킵"
  exit 0
fi

CURRENT_IP=$(/usr/sbin/ipconfig getifaddr "$IFACE" 2>/dev/null)
if [ -z "$CURRENT_IP" ]; then
  echo "[$(date '+%H:%M:%S')] $IFACE 에 IPv4 없음. 스킵"
  exit 0
fi

PREV_IP=""
[ -f "$STATE_FILE" ] && PREV_IP=$(cat "$STATE_FILE")

if [ -z "$PREV_IP" ]; then
  echo "[$(date '+%H:%M:%S')] 초기 등록: $CURRENT_IP ($IFACE)"
  MID=$(send_msg "🏠 가계부 대시보드 LAN IP 등록됨
주소: http://${CURRENT_IP}:${PORT}")
  rotate_pin "$MID"
  echo "$CURRENT_IP" > "$STATE_FILE"
  exit 0
fi

if [ "$PREV_IP" = "$CURRENT_IP" ]; then
  echo "[$(date '+%H:%M:%S')] 변경 없음: $CURRENT_IP"
  exit 0
fi

echo "[$(date '+%H:%M:%S')] IP 변경 감지: $PREV_IP → $CURRENT_IP"
MID=$(send_msg "🔄 가계부 대시보드 LAN IP 변경됨
http://${CURRENT_IP}:${PORT}")
rotate_pin "$MID"
echo "$CURRENT_IP" > "$STATE_FILE"
