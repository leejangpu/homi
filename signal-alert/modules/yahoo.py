"""yfinance로 일봉 종가 시리즈 조회."""

import yfinance as yf


def fetch_daily_closes(symbol: str, range_: str = "3mo") -> list[float]:
    """심볼의 일봉 종가 리스트 (오래된 순)."""
    ticker = yf.Ticker(symbol)
    hist = ticker.history(period=range_, interval="1d", auto_adjust=False)
    closes = hist["Close"].dropna().tolist()
    if not closes:
        raise RuntimeError(f"{symbol} 종가 데이터 없음")
    return [float(c) for c in closes]


def fetch_last_close(symbol: str) -> float:
    return fetch_daily_closes(symbol, range_="5d")[-1]
