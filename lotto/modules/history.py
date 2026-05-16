"""구매/당첨 내역 조회 및 JSON 히스토리 관리 모듈."""

from __future__ import annotations
import json
import logging
import os
import subprocess
from datetime import datetime, timedelta
from playwright.sync_api import Page

logger = logging.getLogger("lotto")

HISTORY_URL = "https://www.dhlottery.co.kr/mypage/mylotteryledger"

# history.json 경로 (lotto/ 디렉토리)
SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY_JSON_PATH = os.path.join(SCRIPT_DIR, "history.json")


# ─────────────────────────────────────────────
# history.json 읽기/쓰기
# ─────────────────────────────────────────────

def _load_history() -> dict:
    """history.json을 읽어 반환. 파일이 없으면 빈 구조를 반환."""
    if os.path.exists(HISTORY_JSON_PATH):
        try:
            with open(HISTORY_JSON_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning("history.json 읽기 실패: %s", e)
    return {"purchases": [], "stats": {"totalSpent": 0, "totalWon": 0, "totalRounds": 0}}


def _save_history(data: dict) -> None:
    """history.json에 데이터를 저장."""
    try:
        with open(HISTORY_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        logger.info("history.json 저장 완료")
    except Exception as e:
        logger.warning("history.json 저장 실패: %s", e)


def _recalc_stats(data: dict) -> None:
    """purchases 목록을 기반으로 stats를 재계산."""
    total_spent = sum(p.get("totalAmount", 0) for p in data["purchases"])
    total_won = sum(p.get("winnings", 0) for p in data["purchases"])
    total_rounds = len(data["purchases"])
    data["stats"] = {
        "totalSpent": total_spent,
        "totalWon": total_won,
        "totalRounds": total_rounds,
    }


def _git_push_history() -> None:
    """history.json을 git add → commit → push."""
    try:
        subprocess.run(
            ["git", "add", "history.json"],
            cwd=SCRIPT_DIR,
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=SCRIPT_DIR,
            capture_output=True,
        )
        if result.returncode == 0:
            logger.info("history.json: 변경 사항 없음, git commit 생략")
            return
        subprocess.run(
            ["git", "commit", "-m", "로또 히스토리 업데이트"],
            cwd=SCRIPT_DIR,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "push"],
            cwd=SCRIPT_DIR,
            check=True,
            capture_output=True,
        )
        logger.info("history.json git push 완료")
    except subprocess.CalledProcessError as e:
        logger.warning("history.json git push 실패: %s", e)


# ─────────────────────────────────────────────
# 구매 시 호출
# ─────────────────────────────────────────────

def _get_draw_date(buy_date_str: str) -> str:
    """구매일 기준으로 추첨일(토요일)을 계산한다.

    - 월~토 구매: 그 주 토요일
    - 일요일 구매: 다음 주 토요일 (당일 추첨 없음)
    """
    try:
        buy_date = datetime.strptime(buy_date_str, "%Y-%m-%d")
        weekday = buy_date.weekday()
        if weekday == 6:
            # 일요일이면 다음 주 토요일 (+6일)
            days_to_saturday = 6
        else:
            days_to_saturday = 5 - weekday
        draw_date = buy_date + timedelta(days=days_to_saturday)
        return draw_date.strftime("%Y-%m-%d")
    except Exception:
        return ""


def _get_lotto_round_for_date(buy_date_str: str) -> int:
    """구매일 기준으로 해당 회차를 추정한다.

    기준: 2026-04-11(토) = 1219회 추첨.
    구매일에서 추첨 토요일을 구한 뒤 기준 주 대비 delta로 회차를 계산.
    """
    base_saturday = datetime(2026, 4, 11)  # 1219회 추첨일 (토요일)
    base_round = 1219
    try:
        draw_date_str = _get_draw_date(buy_date_str)
        if not draw_date_str:
            return 0
        draw_date = datetime.strptime(draw_date_str, "%Y-%m-%d")
        delta_weeks = (draw_date - base_saturday).days // 7
        return base_round + delta_weeks
    except Exception:
        return 0


def save_purchase_to_history(
    tickets: list[list[int]],
    mode: str,
    total_amount: int,
    round_no: int = 0,
) -> None:
    """구매 완료 후 history.json에 구매 내역을 추가한다.

    Args:
        tickets: 구매한 번호 목록. 자동선택이면 빈 리스트.
        mode: "random" | "auto" | "manual"
        total_amount: 총 구매 금액 (원)
        round_no: 회차 번호 (0이면 날짜로 추정)
    """
    try:
        data = _load_history()
        buy_date = datetime.now().strftime("%Y-%m-%d")

        if round_no == 0:
            round_no = _get_lotto_round_for_date(buy_date)

        draw_date = _get_draw_date(buy_date)

        ticket_objs = [{"numbers": sorted(nums), "mode": mode} for nums in tickets]

        # 동일 회차가 이미 있으면 덮어쓰지 않고 스킵
        existing_rounds = [p["round"] for p in data["purchases"]]
        if round_no in existing_rounds:
            logger.info("회차 %d 구매 내역이 이미 존재합니다. 스킵.", round_no)
            return

        entry = {
            "round": round_no,
            "buyDate": buy_date,
            "drawDate": draw_date,
            "tickets": ticket_objs,
            "totalAmount": total_amount,
            "result": "pending",
            "winnings": 0,
            "winDetail": "",
        }

        data["purchases"].append(entry)
        _recalc_stats(data)
        _save_history(data)
        _git_push_history()
        logger.info("구매 내역 history.json 저장 완료 (회차: %d)", round_no)
    except Exception as e:
        logger.warning("save_purchase_to_history 오류 (무시): %s", e)


# ─────────────────────────────────────────────
# 당첨 확인 시 호출
# ─────────────────────────────────────────────

def update_result_in_history(site_history: list[dict]) -> None:
    """사이트에서 가져온 내역으로 history.json의 결과를 업데이트한다.

    Args:
        site_history: get_purchase_history()의 반환값
    """
    try:
        data = _load_history()
        changed = False

        for site_entry in site_history:
            try:
                site_round = int(site_entry.get("round", 0))
            except (ValueError, TypeError):
                continue

            site_result = site_entry.get("result", "미확인")
            amount_str = site_entry.get("amount", "0")

            # 금액 파싱 ("5,000 원" → 5000)
            winnings = 0
            try:
                cleaned = amount_str.replace(",", "").replace("원", "").strip()
                if cleaned and cleaned != "-":
                    winnings = int(cleaned)
            except (ValueError, TypeError):
                winnings = 0

            # 결과 매핑
            if site_result == "당첨":
                win_detail = f"당첨 ({winnings:,}원)" if winnings > 0 else "당첨"
            elif site_result == "낙첨":
                win_detail = "낙첨"
                winnings = 0
            elif site_result == "미추첨":
                win_detail = "미추첨"
            else:
                win_detail = site_result

            # purchases에서 해당 회차 찾아 업데이트
            for purchase in data["purchases"]:
                if purchase["round"] == site_round:
                    if purchase["result"] != site_result or purchase["winnings"] != winnings:
                        purchase["result"] = site_result
                        purchase["winnings"] = winnings
                        purchase["winDetail"] = win_detail
                        changed = True
                        logger.info(
                            "회차 %d 결과 업데이트: %s (당첨금: %d원)",
                            site_round, site_result, winnings,
                        )
                    break

        if changed:
            _recalc_stats(data)
            _save_history(data)
            _git_push_history()
        else:
            logger.info("history.json 업데이트 없음 (변경사항 없음)")
    except Exception as e:
        logger.warning("update_result_in_history 오류 (무시): %s", e)


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
        draw_date = entry.get("draw_date", "") or entry.get("buy_date", "")

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
        if draw_date:
            line += f"  [추첨일: {draw_date}]"
        lines.append(line)

    return "\n".join(lines)
