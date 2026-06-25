"""RSI(14) 계산 — Wilder smoothing."""


def rsi(closes: list[float], period: int = 14) -> float:
    """일봉 종가 시리즈에서 마지막 RSI 값.

    Wilder의 지수가중 평균 사용.
    """
    if len(closes) < period + 1:
        raise ValueError(f"RSI 계산에 최소 {period + 1}개 종가 필요 (현재 {len(closes)}개)")

    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0.0))
        losses.append(max(-diff, 0.0))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))
