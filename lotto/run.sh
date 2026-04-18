#!/bin/bash
# cron에서 실행할 래퍼 스크립트
# cron은 환경변수가 제한적이므로 PATH와 작업 디렉토리를 명시적으로 설정

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
DIAG_LOG="$LOG_DIR/purchase-diag.log"

# 진단 로그 시작
{
    echo "========================================"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] run.sh 시작"
    echo "  USER: $(whoami)"
    echo "  HOME: $HOME"
    echo "  PWD: $(pwd)"
    echo "  DISPLAY: ${DISPLAY:-없음}"
    echo "  PATH (before): $PATH"
} >> "$DIAG_LOG" 2>&1

# pyenv 또는 시스템 Python 경로 설정
export PATH="$HOME/.pyenv/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
echo "  PATH (after): $PATH" >> "$DIAG_LOG" 2>&1

# .env 파일에서 환경변수 로드
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
    echo "  .env 로드 완료" >> "$DIAG_LOG" 2>&1
else
    echo "  [ERROR] .env 파일 없음!" >> "$DIAG_LOG" 2>&1
fi

# 시작일 이전이면 스킵 (2026-03-16부터 실행)
if [ "$(date +%Y%m%d)" -lt "20260316" ]; then
    echo "[$(date)] 시작일(2026-03-16) 이전 - 스킵" >> "$DIAG_LOG" 2>&1
    exit 0
fi

# 가상환경 활성화
if [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
    source "$SCRIPT_DIR/.venv/bin/activate"
    echo "  venv 활성화 완료: $(which python3)" >> "$DIAG_LOG" 2>&1
    echo "  Python 버전: $(python3 --version 2>&1)" >> "$DIAG_LOG" 2>&1
else
    echo "  [ERROR] venv 없음!" >> "$DIAG_LOG" 2>&1
    exit 1
fi

echo "  실행 시작: python3 main.py" >> "$DIAG_LOG" 2>&1

# 실행
python3 main.py 2>&1
EXIT_CODE=$?

{
    echo "  종료 코드: $EXIT_CODE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] run.sh 종료"
    echo "========================================"
    echo ""
} >> "$DIAG_LOG" 2>&1

exit $EXIT_CODE
