"""로그인 및 세션 관리 모듈."""

import os
import logging
from playwright.sync_api import Page, BrowserContext

logger = logging.getLogger("lotto")

COOKIE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "state.json")
LOGIN_URL = "https://www.dhlottery.co.kr/login"
MAIN_URL = "https://www.dhlottery.co.kr"


def save_session(context: BrowserContext) -> None:
    """현재 브라우저 세션(쿠키)을 파일로 저장."""
    context.storage_state(path=COOKIE_PATH)
    logger.info("세션 저장 완료: %s", COOKIE_PATH)


def is_logged_in(page: Page) -> bool:
    """현재 페이지에서 로그인 상태를 확인."""
    page.goto(MAIN_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)

    # 로그인 상태면 '로그아웃' 버튼이 보임
    logout_btn = page.query_selector("button#logoutBtn, a[href*='logout'], button:has-text('로그아웃')")
    if logout_btn:
        return True

    # 로그인 버튼이 보이면 미로그인 상태
    login_btn = page.query_selector("button#loginBtn, a:has-text('로그인')")
    if login_btn:
        return False

    return False


def login(page: Page, user_id: str, user_pw: str) -> bool:
    """동행복권 사이트에 로그인한다.

    Returns:
        True: 로그인 성공, False: 실패
    """
    logger.info("로그인 페이지로 이동 중...")
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)

    # 아이디/비밀번호 입력
    page.fill("#inpUserId", user_id)
    page.fill("#inpUserPswdEncn", user_pw)

    # 로그인 버튼 클릭
    page.click("#btnLogin")
    page.wait_for_timeout(3000)
    page.wait_for_load_state("domcontentloaded", timeout=15000)

    # 로그인 결과 확인
    # 로그인 성공 시 메인 페이지로 이동하거나 URL이 변경됨
    current_url = page.url
    logger.debug("로그인 후 URL: %s", current_url)

    # 로그인 페이지에 그대로 있으면 실패
    if "/login" in current_url:
        # 에러 메시지 확인
        error_msg = page.query_selector(".alert-msg, .error-msg, .popup-msg")
        if error_msg:
            logger.warning("로그인 오류: %s", error_msg.inner_text())
        logger.warning("로그인 실패 - 로그인 페이지에서 벗어나지 못함")
        return False

    # 메인 페이지에서 로그아웃 버튼 확인
    logout_btn = page.query_selector("button#logoutBtn, a[href*='logout'], button:has-text('로그아웃')")
    if logout_btn:
        logger.info("로그인 성공!")
        return True

    # URL이 변경되었으면 일단 성공으로 판단
    logger.info("로그인 성공 (URL 변경 확인: %s)", current_url)
    return True


def login_with_retry(page: Page, user_id: str, user_pw: str, max_retries: int = 2) -> bool:
    """로그인 실패 시 재시도."""
    for attempt in range(1, max_retries + 1):
        logger.info("로그인 시도 %d/%d", attempt, max_retries)
        try:
            if login(page, user_id, user_pw):
                return True
        except Exception as e:
            logger.warning("로그인 중 오류: %s", e)
        logger.warning("로그인 실패 (시도 %d/%d)", attempt, max_retries)
    return False
