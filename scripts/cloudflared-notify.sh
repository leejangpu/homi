#!/bin/bash
# cloudflared Quick Tunnel URL이 로그에 나타나면 텔레그램으로 알림 전송
# launchd KeepAlive=true 로 동작: 전송 후 종료 → launchd가 재시작하여 다음 재시작 대기

LOG="/Users/mac_ad03249840/Developer/homi/logs/cloudflared.log"
ENV="/Users/mac_ad03249840/Developer/homi/infinite-buy/.env"

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
CHAT_ID=$(grep '^TELEGRAM_CHAT_ID=' "$ENV" | cut -d= -f2-)

echo "[$(date '+%Y-%m-%d %H:%M:%S')] cloudflared URL 감시 시작"

tail -f -n 0 "$LOG" | while IFS= read -r line; do
    if [[ "$line" =~ https://[a-zA-Z0-9-]+\.trycloudflare\.com ]]; then
        URL="${BASH_REMATCH[0]}"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] URL 감지: $URL"
        curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
            -d "chat_id=${CHAT_ID}" \
            --data-urlencode "text=🌐 가계부 대시보드 접속 URL
${URL}" > /dev/null
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 텔레그램 전송 완료"
        break
    fi
done
