#!/bin/bash
# cron에서 실행할 래퍼 스크립트
# cron은 환경변수가 제한적이므로 PATH와 작업 디렉토리를 명시적으로 설정

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# pyenv 또는 시스템 Python 경로 설정
export PATH="$HOME/.pyenv/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# .env 파일에서 환경변수 로드
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# 시작일 이전이면 스킵 (2026-03-16부터 실행)
if [ "$(date +%Y%m%d)" -lt "20260316" ]; then
    echo "[$(date)] 시작일(2026-03-16) 이전 - 스킵"
    exit 0
fi

# 가상환경 활성화
source "$SCRIPT_DIR/.venv/bin/activate"

# 실행
python3 main.py 2>&1
