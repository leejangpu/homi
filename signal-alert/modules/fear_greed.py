"""CNN Fear & Greed Index 조회."""

import json
import urllib.request


CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"


def fetch_fear_greed() -> tuple[float, str]:
    """현재 CNN 공포탐욕지수와 레이팅을 반환."""
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://edition.cnn.com/",
        "Origin": "https://edition.cnn.com",
    }
    req = urllib.request.Request(CNN_URL, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    fg = data["fear_and_greed"]
    return float(fg["score"]), str(fg["rating"])
