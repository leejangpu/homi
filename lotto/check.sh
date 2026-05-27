#!/bin/bash
# 토요일 당첨확인 전용 래퍼 스크립트

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
DIAG_LOG="$LOG_DIR/check-diag.log"

# 진단 로그 시작
{
    echo "========================================"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] check.sh 시작"
    echo "  USER: $(whoami)"
    echo "  HOME: $HOME"
    echo "  PWD: $(pwd)"
    echo "  DISPLAY: ${DISPLAY:-없음}"
    echo "  TERM: ${TERM:-없음}"
    echo "  PATH (before): $PATH"
} >> "$DIAG_LOG" 2>&1

export PATH="$HOME/.pyenv/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
echo "  PATH (after): $PATH" >> "$DIAG_LOG" 2>&1

# .env 로드
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
    echo "  .env 로드 완료" >> "$DIAG_LOG" 2>&1
else
    echo "  [ERROR] .env 파일 없음!" >> "$DIAG_LOG" 2>&1
fi

# venv python3 절대 경로 사용 (activate 스크립트 경로 하드코딩 문제 우회)
PYTHON="$SCRIPT_DIR/.venv/bin/python3"
if [ ! -f "$PYTHON" ]; then
    echo "  [ERROR] venv 없음: $PYTHON" >> "$DIAG_LOG" 2>&1
    exit 1
fi
echo "  venv python: $PYTHON" >> "$DIAG_LOG" 2>&1
echo "  Python 버전: $($PYTHON --version 2>&1)" >> "$DIAG_LOG" 2>&1

# Playwright 브라우저 확인
$PYTHON -c "
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    browser.close()
    print('  Playwright 브라우저 정상')
" >> "$DIAG_LOG" 2>&1
if [ $? -ne 0 ]; then
    echo "  [ERROR] Playwright 브라우저 실행 실패!" >> "$DIAG_LOG" 2>&1
fi

echo "  실행 시작: $PYTHON main.py --check" >> "$DIAG_LOG" 2>&1

# 본 스크립트 실행 (stdout+stderr 모두 캡처)
$PYTHON main.py --check 2>&1
EXIT_CODE=$?

{
    echo "  종료 코드: $EXIT_CODE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] check.sh 종료"
    echo "========================================"
    echo ""
} >> "$DIAG_LOG" 2>&1

exit $EXIT_CODE
