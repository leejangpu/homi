"""구매/당첨 내역 조회 모듈."""

import logging
from playwright.sync_api import Page

logger = logging.getLogger("lotto")

HISTORY_URL = "https://www.dhlottery.co.kr/mypage/mylotteryledger"


def get_purchase_history(page: Page) -> list[dict]:
    """구매/당첨 내역 페이지에서 최근 내역을 파싱한다.

    Returns:
        [{"round": "1214", "game": "로또6/45", "numbers": "60155 06832 ...",
          "result": "낙첨", "amount": "0 원", "count": "5",
          "buy_date": "2026-03-03", "draw_date": "2026-03-07"}, ...]
    """
    logger.info("구매/당첨 내역 페이지로 이동 중...")
    page.goto(HISTORY_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)

    # 기본 조회기간(최근 1주일)으로 직전 회차 확인

    body_el = page.query_selector("#winning-history-list .whl-body")
    if not body_el:
        logger.warning("당첨 내역을 찾을 수 없습니다.")
        return []

    text = body_el.inner_text()
    lines = [line.strip() for line in text.split("\n") if line.strip()]

    # "구입일자"를 기준으로 항목 분리
    entries_raw = []
    current = []
    for line in lines:
        if line == "구입일자" and current:
            entries_raw.append(current)
            current = []
        current.append(line)
    if current:
        entries_raw.append(current)

    results = []
    for entry_lines in entries_raw:
        entry = _parse_entry(entry_lines)
        if entry:
            results.append(entry)
            logger.info("회차 %s: %s (%s)", entry["round"], entry["result"], entry.get("amount", ""))

    return results


def _parse_entry(lines: list[str]) -> dict | None:
    """하나의 구매 항목 텍스트 라인 목록을 파싱한다.

    예상 순서: 구입일자, 날짜, 복권명, 회차, 번호, 구입매수, 매수, 결과, 금액, 추첨일자, 날짜
    """
    entry = {
        "game": "", "round": "", "numbers": "", "result": "미확인",
        "amount": "", "count": "", "buy_date": "", "draw_date": "",
    }

    i = 0
    while i < len(lines):
        line = lines[i]

        if line == "구입일자" and i + 1 < len(lines):
            i += 1
            entry["buy_date"] = lines[i]
        elif "로또" in line or "645" in line:
            entry["game"] = line
        elif line == "구입매수" and i + 1 < len(lines):
            i += 1
            entry["count"] = lines[i]
        elif line == "추첨일자" and i + 1 < len(lines):
            i += 1
            entry["draw_date"] = lines[i]
        elif line in ("당첨", "낙첨", "미추첨", "미확인"):
            entry["result"] = line
        elif "원" in line and any(c.isdigit() for c in line):
            entry["amount"] = line
        elif line.isdigit() and len(line) <= 5 and not entry["round"]:
            # 회차 번호 (4~5자리 숫자)
            entry["round"] = line
        elif " " in line and any(c.isdigit() for c in line) and len(line) > 10:
            # 선택번호 (공백으로 구분된 긴 숫자열)
            entry["numbers"] = line
        elif line == "-":
            # 당첨금 없음
            if not entry["amount"]:
                entry["amount"] = "-"

        i += 1

    if not entry["round"]:
        return None

    return entry


def format_history_message(history: list[dict]) -> str:
    """당첨 내역을 텔레그램 메시지 형식으로 포맷한다."""
    if not history:
        return "구매 내역이 없습니다."

    lines = ["<b>📋 로또 구매/당첨 내역</b>", ""]

    for entry in history:
        round_no = entry.get("round", "?")
        result = entry.get("result", "미확인")
        amount = entry.get("amount", "")
        buy_date = entry.get("buy_date", "")

        if result == "당첨":
            icon = "🎉"
        elif result == "낙첨":
            icon = "❌"
        elif result == "미추첨":
            icon = "⏳"
        else:
            icon = "❓"

        line = f"{icon} <b>{round_no}회</b> — {result}"
        if amount and amount != "-":
            line += f" ({amount})"
        if buy_date:
            line += f"  [{buy_date}]"
        lines.append(line)

    return "\n".join(lines)
