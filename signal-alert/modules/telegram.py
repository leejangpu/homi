"""텔레그램 알림."""

import json
import logging
import os
import urllib.parse
import urllib.request

logger = logging.getLogger("signal-alert")


def send_telegram(message: str) -> bool:
    """텔레그램 봇으로 평문 메시지 전송."""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        logger.warning("텔레그램 설정 없음")
        return False

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": message,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                logger.info("텔레그램 전송 성공")
                return True
            logger.warning("텔레그램 응답 오류: %s", result)
            return False
    except Exception as e:
        logger.error("텔레그램 전송 실패: %s", e)
        return False
