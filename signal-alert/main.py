"""시장 신호 알림 — 공포탐욕 + VIX + RSI 교집합 모니터.

매수 신호: F&G < 20 AND RSI ≤ 30 AND VIX ≥ 30
매도 신호: F&G ≥ 80 AND RSI ≥ 70 AND VIX ≤ 15

사용법:
  python main.py            # 일일 체크 (조건 충족시에만 알림)
  python main.py --test     # 현재 지표를 무조건 텔레그램으로 전송 (작동 확인용)
  python main.py --print    # 콘솔 출력만 (텔레그램 미발송)
"""

import argparse
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

from modules.fear_greed import fetch_fear_greed
from modules.rsi import rsi
from modules.telegram import send_telegram
from modules.yahoo import fetch_daily_closes, fetch_last_close

LOG_FILE = ROOT / "logs" / "signal-alert.log"
LOG_FILE.parent.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("signal-alert")


BUY_FG_MAX = 20      # F&G < 20
BUY_RSI_MAX = 30     # RSI ≤ 30
BUY_VIX_MIN = 30     # VIX ≥ 30

SELL_FG_MIN = 80     # F&G ≥ 80
SELL_RSI_MIN = 70    # RSI ≥ 70
SELL_VIX_MAX = 15    # VIX ≤ 15


def collect_indicators(tickers: list[str]) -> dict:
    """모든 지표를 수집해 dict로 반환."""
    logger.info("CNN 공포탐욕지수 조회")
    fg_score, fg_rating = fetch_fear_greed()

    logger.info("VIX 종가 조회")
    vix = fetch_last_close("^VIX")

    ticker_data: dict[str, dict] = {}
    for t in tickers:
        logger.info("%s 일봉 + RSI(14) 계산", t)
        closes = fetch_daily_closes(t, range_="3mo")
        ticker_data[t] = {
            "close": closes[-1],
            "rsi": rsi(closes, period=14),
        }

    return {
        "fg_score": fg_score,
        "fg_rating": fg_rating,
        "vix": vix,
        "tickers": ticker_data,
    }


def evaluate(indicators: dict) -> dict[str, dict]:
    """티커별 매수/매도 신호 평가."""
    fg = indicators["fg_score"]
    vix = indicators["vix"]
    result: dict[str, dict] = {}
    for t, d in indicators["tickers"].items():
        r = d["rsi"]
        buy = fg < BUY_FG_MAX and r <= BUY_RSI_MAX and vix >= BUY_VIX_MIN
        sell = fg >= SELL_FG_MIN and r >= SELL_RSI_MIN and vix <= SELL_VIX_MAX
        result[t] = {"buy": buy, "sell": sell}
    return result


def format_status_message(indicators: dict, signals: dict[str, dict], header: str) -> str:
    """현재 지표 + 평가 결과를 평문으로 포맷."""
    fg = indicators["fg_score"]
    vix = indicators["vix"]
    lines = [
        header,
        "",
        f"공포탐욕지수: {fg:.1f} ({indicators['fg_rating']})",
        f"VIX: {vix:.2f}",
        "",
    ]
    for t, d in indicators["tickers"].items():
        sig = signals[t]
        tag = ""
        if sig["buy"]:
            tag = "  ← 매수 교집합 충족"
        elif sig["sell"]:
            tag = "  ← 매도 교집합 충족"
        lines.append(f"{t}: 종가 ${d['close']:.2f} / RSI {d['rsi']:.1f}{tag}")

    lines.append("")
    lines.append(f"매수 조건: F&G<{BUY_FG_MAX} & RSI≤{BUY_RSI_MAX} & VIX≥{BUY_VIX_MIN}")
    lines.append(f"매도 조건: F&G≥{SELL_FG_MIN} & RSI≥{SELL_RSI_MIN} & VIX≤{SELL_VIX_MAX}")
    return "\n".join(lines)


def format_signal_message(ticker: str, side: str, indicators: dict, ticker_data: dict) -> str:
    emoji = "🟢" if side == "buy" else "🔴"
    side_kr = "매수신호 발생" if side == "buy" else "매도신호 발생"
    return (
        f"{emoji} {ticker} {side_kr}\n"
        "\n"
        f"공포탐욕: {indicators['fg_score']:.0f} ({indicators['fg_rating']})\n"
        f"VIX: {indicators['vix']:.2f}\n"
        f"RSI: {ticker_data['rsi']:.1f}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true", help="조건과 무관하게 현재 지표 전송")
    parser.add_argument("--print", dest="print_only", action="store_true", help="텔레그램 발송 없이 콘솔만")
    parser.add_argument("--sample", choices=["buy", "sell", "both"], help="가짜 지표로 샘플 신호 메시지 발송 (포맷 확인용)")
    args = parser.parse_args()

    if args.sample:
        sides = ["buy", "sell"] if args.sample == "both" else [args.sample]
        tickers_env = os.environ.get("SIGNAL_TICKERS", "QLD").strip()
        ticker = [t.strip().upper() for t in tickers_env.split(",") if t.strip()][0]
        samples = {
            "buy": (
                {"fg_score": 18.0, "fg_rating": "extreme fear", "vix": 32.5},
                {"close": 78.20, "rsi": 28.4},
            ),
            "sell": (
                {"fg_score": 85.0, "fg_rating": "extreme greed", "vix": 12.8},
                {"close": 112.40, "rsi": 73.2},
            ),
        }
        for s in sides:
            ind, td = samples[s]
            send_telegram(format_signal_message(ticker, s, ind, td))
        return 0

    tickers_env = os.environ.get("SIGNAL_TICKERS", "QLD").strip()
    tickers = [t.strip().upper() for t in tickers_env.split(",") if t.strip()]
    logger.info("감시 종목: %s", ", ".join(tickers))

    try:
        indicators = collect_indicators(tickers)
    except Exception as e:
        logger.exception("지표 수집 실패")
        if not args.print_only:
            send_telegram(f"⚠️ signal-alert 오류\n\n지표 수집 실패: {e}")
        return 1

    signals = evaluate(indicators)

    status_msg = format_status_message(
        indicators, signals, header="📊 시장 신호 현황 (테스트)" if args.test else "📊 시장 신호 현황"
    )
    print(status_msg)

    if args.print_only:
        return 0

    if args.test:
        ok = send_telegram(status_msg)
        return 0 if ok else 2

    sent_any = False
    for t, sig in signals.items():
        if sig["buy"]:
            send_telegram(format_signal_message(t, "buy", indicators, indicators["tickers"][t]))
            sent_any = True
        elif sig["sell"]:
            send_telegram(format_signal_message(t, "sell", indicators, indicators["tickers"][t]))
            sent_any = True

    if not sent_any:
        logger.info("조건 미충족 — 알림 미발송")
    return 0


if __name__ == "__main__":
    sys.exit(main())
