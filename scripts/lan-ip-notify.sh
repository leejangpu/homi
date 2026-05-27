#!/bin/bash
# Mac LAN IP 변경 감지 → 텔레그램 알림
# launchd StartInterval로 주기적 호출 (기본 1시간)
# 이전 IP는 /tmp/homi-lan-ip 에 저장. 다르면 알림 전송 후 갱신.

ENV="/Users/mac_ad03249840/Developer/homi/infinite-buy/.env"
STATE_FILE="/tmp/homi-lan-ip"
PORT=3000

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_CHAT_ID=' "$ENV" | cut -d= -f2-)

send_msg() {
  if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo "[$(date '+%H:%M:%S')] 텔레그램 자격 없음, 알림 스킵"
    return
  fi
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" > /dev/null
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
if [ -f "$STATE_FILE" ]; then
  PREV_IP=$(cat "$STATE_FILE")
fi

if [ -z "$PREV_IP" ]; then
  echo "[$(date '+%H:%M:%S')] 초기 등록: $CURRENT_IP ($IFACE)"
  send_msg "🏠 가계부 대시보드 LAN IP 등록됨
인터페이스: ${IFACE}
주소: http://${CURRENT_IP}:${PORT}"
  echo "$CURRENT_IP" > "$STATE_FILE"
  exit 0
fi

if [ "$PREV_IP" = "$CURRENT_IP" ]; then
  echo "[$(date '+%H:%M:%S')] 변경 없음: $CURRENT_IP"
  exit 0
fi

echo "[$(date '+%H:%M:%S')] IP 변경 감지: $PREV_IP → $CURRENT_IP"
send_msg "🔄 가계부 대시보드 LAN IP 변경됨
이전: http://${PREV_IP}:${PORT}
현재: http://${CURRENT_IP}:${PORT}
인터페이스: ${IFACE}"
echo "$CURRENT_IP" > "$STATE_FILE"
