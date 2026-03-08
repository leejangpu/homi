"""텔레그램 알림 모듈."""

import os
import logging
import urllib.request
import urllib.parse
import json

logger = logging.getLogger("lotto")


def send_telegram(message: str) -> bool:
    """텔레그램 봇으로 메시지를 전송한다.

    환경변수 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 필요.
    Returns:
        True: 전송 성공, False: 실패
    """
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not bot_token or not chat_id:
        logger.warning("텔레그램 설정 없음 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)")
        return False

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
    }).encode("utf-8")

    try:
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                logger.info("텔레그램 전송 성공")
                return True
            else:
                logger.warning("텔레그램 응답 오류: %s", result)
                return False
    except Exception as e:
        logger.error("텔레그램 전송 실패: %s", e)
        return False


def send_purchase_result(games: list[list[int]], total_amount: int, balance: int = -1) -> None:
    """구매 결과를 텔레그램으로 전송한다."""
    lines = ["<b>🎱 로또 구매 완료!</b>", ""]

    for i, nums in enumerate(games, 1):
        nums_str = " - ".join(str(n).zfill(2) for n in sorted(nums))
        lines.append(f"게임 {i}: <code>{nums_str}</code>")

    lines.append("")
    lines.append(f"매수: {len(games)}게임")
    lines.append(f"금액: {total_amount:,}원")

    if balance >= 0:
        lines.append(f"잔액: {balance:,}원")
        if balance == 0:
            lines.append("")
            lines.append("⚠️ <b>예치금이 0원입니다. 충전이 필요합니다!</b>")

    lines.append("")
    lines.append("행운을 빕니다! 🍀")

    send_telegram("\n".join(lines))


def send_purchase_auto_result(ticket_count: int, balance: int = -1) -> None:
    """사이트 자동선택 구매 결과를 텔레그램으로 전송한다."""
    lines = [
        "<b>🎱 로또 구매 완료!</b>",
        "",
        f"모드: 사이트 자동선택",
        f"매수: {ticket_count}게임",
        f"금액: {ticket_count * 1000:,}원",
    ]

    if balance >= 0:
        lines.append(f"잔액: {balance:,}원")
        if balance == 0:
            lines.append("")
            lines.append("⚠️ <b>예치금이 0원입니다. 충전이 필요합니다!</b>")

    lines.append("")
    lines.append("번호는 마이페이지에서 확인하세요.")
    lines.append("행운을 빕니다! 🍀")
    send_telegram("\n".join(lines))


def send_error_alert(error_msg: str) -> None:
    """오류 발생 시 텔레그램으로 알림을 보낸다."""
    message = f"<b>⚠️ 로또 구매 오류</b>\n\n{error_msg}"
    send_telegram(message)
