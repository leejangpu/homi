#!/bin/bash
# 토요일 당첨확인 전용 래퍼 스크립트

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="$HOME/.pyenv/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

source "$SCRIPT_DIR/.venv/bin/activate"

python3 main.py --check 2>&1
