#!/usr/bin/env python3
"""동행복권 로또 자동 구매 메인 스크립트.

Usage:
    python main.py                                            # 랜덤번호 5게임 (기본)
    python main.py --auto                                     # 사이트 자동선택 5게임
    python main.py --numbers "1,2,3,4,5,6 / 7,8,9,10,11,12"  # 직접 번호 지정
    python main.py --dry-run                                  # 로그인만 테스트
"""

import os
import sys
import argparse
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

from modules.logger import setup_logger
from modules.auth import login_with_retry, save_session, is_logged_in, COOKIE_PATH
from modules.number_generator import generate_lotto_numbers
from modules.purchase import purchase_lotto_auto, purchase_lotto_manual, handle_purchase_error
from modules.telegram import send_purchase_result, send_purchase_auto_result, send_error_alert, send_telegram
from modules.history import get_purchase_history, format_history_message

# .env 파일 로드 (스크립트 디렉토리 기준)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(SCRIPT_DIR, ".env"))

logger = setup_logger()


def get_credentials() -> tuple[str, str]:
    """환경변수에서 로그인 정보를 가져온다."""
    user_id = os.environ.get("LOTTO_USER_ID", "")
    user_pw = os.environ.get("LOTTO_USER_PW", "")
    if not user_id or not user_pw:
        logger.error("환경변수 LOTTO_USER_ID, LOTTO_USER_PW가 설정되지 않았습니다.")
        sys.exit(1)
    return user_id, user_pw


def parse_manual_numbers(manual_str: str) -> list[list[int]]:
    """직접 지정한 번호 문자열을 파싱한다.

    형식: "1,2,3,4,5,6 / 7,8,9,10,11,12 / ..."
    """
    games = []
    for game_str in manual_str.split("/"):
        nums = [int(n.strip()) for n in game_str.strip().split(",")]
        if len(nums) != 6:
            logger.error("각 게임은 6개의 번호가 필요합니다: %s", game_str.strip())
            sys.exit(1)
        if not all(1 <= n <= 45 for n in nums):
            logger.error("번호는 1~45 사이여야 합니다: %s", nums)
            sys.exit(1)
        if len(set(nums)) != 6:
            logger.error("중복 번호가 있습니다: %s", nums)
            sys.exit(1)
        games.append(nums)
    if len(games) > 5:
        logger.warning("최대 5게임까지 가능합니다. 앞 5게임만 사용합니다.")
        games = games[:5]
    return games


def run(dry_run: bool = False, auto: bool = False, numbers: str | None = None) -> None:
    """메인 실행 로직."""
    logger.info("=" * 50)
    logger.info("로또 자동 구매 시작")
    logger.info("=" * 50)

    user_id, user_pw = get_credentials()
    ticket_count = int(os.environ.get("LOTTO_TICKET_COUNT", "5"))

    with sync_playwright() as p:
        storage_state = COOKIE_PATH if os.path.exists(COOKIE_PATH) else None

        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(
            storage_state=storage_state,
            viewport={"width": 1280, "height": 900},
            locale="ko-KR",
        )
        page = context.new_page()

        try:
            # 저장된 세션으로 로그인 상태인지 확인
            logged_in = False
            if storage_state:
                logger.info("저장된 세션으로 로그인 확인 중...")
                try:
                    logged_in = is_logged_in(page)
                    if logged_in:
                        logger.info("저장된 세션으로 로그인 유지됨")
                except Exception:
                    logger.info("저장된 세션 만료 - 재로그인 필요")

            if not logged_in:
                if not login_with_retry(page, user_id, user_pw):
                    logger.error("로그인 실패 - 프로그램 종료")
                    sys.exit(1)
                save_session(context)

            if dry_run:
                logger.info("--dry-run 모드: 로그인 확인 완료, 구매 없이 종료")
                return

            # 로또 구매
            try:
                purchased_games = None

                if auto:
                    # 사이트 자동선택 기능 사용
                    logger.info("사이트 자동선택 모드: %d게임", ticket_count)
                    success, balance = purchase_lotto_auto(page, ticket_count)
                elif numbers:
                    # 직접 지정한 번호
                    purchased_games = parse_manual_numbers(numbers)
                    logger.info("지정번호 모드: %d게임", len(purchased_games))
                    success, balance = purchase_lotto_manual(page, purchased_games)
                else:
                    # 기본: 랜덤 번호 생성 → 수동 클릭
                    purchased_games = [generate_lotto_numbers() for _ in range(ticket_count)]
                    logger.info("랜덤번호 모드: %d게임", len(purchased_games))
                    for i, g in enumerate(purchased_games, 1):
                        logger.info("  게임 %d: %s", i, g)
                    success, balance = purchase_lotto_manual(page, purchased_games)

                if success:
                    logger.info("구매 프로세스 정상 완료")
                    # 텔레그램 알림
                    if purchased_games:
                        send_purchase_result(purchased_games, len(purchased_games) * 1000, balance)
                    else:
                        send_purchase_auto_result(ticket_count, balance)
                else:
                    logger.warning("구매 결과 확인 필요 - 스크린샷을 확인하세요")


            except Exception as e:
                handle_purchase_error(page, e)
                send_error_alert(str(e))
                sys.exit(1)

        except Exception as e:
            logger.error("예기치 않은 오류: %s", e, exc_info=True)
            sys.exit(1)
        finally:
            context.close()
            browser.close()
            logger.info("브라우저 종료 완료")


def check_history() -> None:
    """구매/당첨 내역을 조회하여 텔레그램으로 전송한다."""
    logger.info("구매/당첨 내역 조회 시작")

    user_id, user_pw = get_credentials()

    with sync_playwright() as p:
        storage_state = COOKIE_PATH if os.path.exists(COOKIE_PATH) else None

        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(
            storage_state=storage_state,
            viewport={"width": 1280, "height": 900},
            locale="ko-KR",
        )
        page = context.new_page()

        try:
            logged_in = False
            if storage_state:
                try:
                    logged_in = is_logged_in(page)
                except Exception:
                    pass

            if not logged_in:
                if not login_with_retry(page, user_id, user_pw):
                    logger.error("로그인 실패")
                    sys.exit(1)
                save_session(context)

            history = get_purchase_history(page)
            if history:
                message = format_history_message(history)
                print(message)
                send_telegram(message)
            else:
                logger.info("조회된 내역 없음")
                send_telegram("📋 로또 내역 조회 결과: 최근 구매 내역이 없습니다.")

        except Exception as e:
            logger.error("내역 조회 오류: %s", e, exc_info=True)
            sys.exit(1)
        finally:
            context.close()
            browser.close()


def main():
    parser = argparse.ArgumentParser(description="동행복권 로또 자동 구매")
    parser.add_argument("--dry-run", action="store_true", help="로그인 테스트만 수행")
    parser.add_argument("--auto", action="store_true", help="사이트 자동선택 기능 사용")
    parser.add_argument("--check", action="store_true", help="구매/당첨 내역만 조회")
    parser.add_argument(
        "--numbers",
        type=str,
        default=None,
        help='직접 번호 지정. 예: "1,2,3,4,5,6 / 7,8,9,10,11,12"',
    )
    args = parser.parse_args()
    if args.check:
        check_history()
    else:
        run(dry_run=args.dry_run, auto=args.auto, numbers=args.numbers)


if __name__ == "__main__":
    main()
