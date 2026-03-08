"""로또 구매 모듈 - 자동번호/수동번호 선택 지원."""

import os
import logging
from datetime import datetime
from playwright.sync_api import Page

logger = logging.getLogger("lotto")

PURCHASE_URL = "https://ol.dhlottery.co.kr/olotto/game/game645.do"
SCREENSHOT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "screenshots")


def _save_screenshot(page: Page, name: str) -> str:
    """스크린샷을 저장하고 경로를 반환."""
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(SCREENSHOT_DIR, f"{name}_{timestamp}.png")
    page.screenshot(path=path, full_page=True)
    logger.info("스크린샷 저장: %s", path)
    return path


def _click_label(page: Page, selector: str) -> None:
    """label 요소를 스크롤 후 클릭 (뷰포트 밖 요소 대응)."""
    locator = page.locator(selector)
    locator.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    locator.click()


def _select_numbers_manual(page: Page, numbers: list[int]) -> None:
    """6개의 번호를 수동으로 label 클릭하여 선택."""
    for num in numbers:
        _click_label(page, f"label[for='check645num{num}']")
        page.wait_for_timeout(300)


def _register_game(page: Page) -> None:
    """확인 버튼을 클릭하여 현재 선택한 번호를 게임에 등록."""
    btn = page.locator("#btnSelectNum")
    btn.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    btn.click()
    page.wait_for_timeout(1000)


def purchase_lotto_auto(page: Page, ticket_count: int = 5) -> tuple[bool, int]:
    """자동번호로 로또를 구매한다."""
    ticket_count = max(1, min(5, ticket_count))
    logger.info("로또 구매 페이지로 이동 중...")

    page.goto(PURCHASE_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)

    # 자동선택 체크 (label 클릭)
    is_checked = page.eval_on_selector("#checkAutoSelect", "e => e.checked")
    if not is_checked:
        _click_label(page, "label[for='checkAutoSelect']")
        page.wait_for_timeout(500)
    logger.info("자동선택 모드 활성화")

    # 매수 선택
    page.select_option("#amoundApply", str(ticket_count))
    page.wait_for_timeout(500)
    logger.info("구매 매수: %d", ticket_count)

    # 확인 → 자동번호 등록
    _register_game(page)
    logger.info("자동번호 %d게임 등록 완료", ticket_count)

    return _do_purchase(page, ticket_count)


def purchase_lotto_manual(page: Page, games: list[list[int]]) -> tuple[bool, int]:
    """수동번호로 로또를 구매한다.

    Args:
        page: Playwright Page 객체
        games: 게임별 번호 리스트. 예: [[1,2,3,4,5,6], [7,8,9,10,11,12], ...]
               최대 5게임, 각 게임은 1~45 중 6개 번호.
    """
    if len(games) > 5:
        games = games[:5]
    logger.info("로또 구매 페이지로 이동 중...")

    page.goto(PURCHASE_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(5000)

    # 자동선택 해제 확인
    is_checked = page.eval_on_selector("#checkAutoSelect", "e => e.checked")
    if is_checked:
        _click_label(page, "label[for='checkAutoSelect']")
        page.wait_for_timeout(500)

    # 각 게임별로 번호 선택 → 등록
    for i, numbers in enumerate(games):
        logger.info("게임 %d - 선택 번호: %s", i + 1, sorted(numbers))
        _select_numbers_manual(page, sorted(numbers))
        _register_game(page)
        logger.info("게임 %d 등록 완료", i + 1)

    return _do_purchase(page, len(games))


def _do_purchase(page: Page, ticket_count: int) -> tuple[bool, int]:
    """등록된 게임을 구매 처리한다 (공통 로직)."""
    # 등록 상태 로깅
    game_labels = ["A", "B", "C", "D", "E"]
    for i in range(ticket_count):
        label = game_labels[i]
        gbn = page.query_selector(f"#selectGbn{label}")
        if gbn:
            logger.info("게임 %s: %s", label, gbn.inner_text())

    _save_screenshot(page, "before_purchase")

    # 구매하기 버튼
    logger.info("구매 버튼 클릭...")
    buy_btn = page.locator("#btnBuy")
    buy_btn.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    buy_btn.click()
    page.wait_for_timeout(2000)

    # 구매 확인 팝업 처리 ("구매하시겠습니까?" → 확인)
    try:
        confirm_btn = page.locator("input[onclick*='closepopupLayerConfirm(true)']")
        if confirm_btn.is_visible(timeout=5000):
            confirm_btn.click()
            page.wait_for_timeout(3000)
            logger.info("구매 확인 팝업 처리 완료")
    except Exception:
        logger.debug("구매 확인 팝업 없음")

    _save_screenshot(page, "purchase_result")

    # 잔액 확인
    balance = _get_balance(page)
    logger.info("구매 후 잔액: %s원", balance)

    logger.info("로또 %d게임 구매 프로세스 완료", ticket_count)
    return True, balance


def _get_balance(page: Page) -> int:
    """구매 페이지에서 보유 예치금 잔액을 읽어온다."""
    try:
        balance_el = page.query_selector("#moneyBalance")
        if balance_el:
            text = balance_el.inner_text().replace(",", "").strip()
            return int(text)
    except Exception as e:
        logger.warning("잔액 확인 실패: %s", e)
    return -1


def handle_purchase_error(page: Page, error: Exception) -> None:
    """구매 실패 시 스크린샷 저장 및 로깅."""
    logger.error("구매 중 오류 발생: %s", error)
    _save_screenshot(page, "purchase_error")
