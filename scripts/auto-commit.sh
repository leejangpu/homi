#!/bin/bash
# Claude Code Stop 훅 — 응답 종료 시 워킹트리 자동 커밋·푸시
# remote control 포함 모든 클로드 세션이 응답을 마칠 때 실행됨.
# - 신규 파일 포함 전체 스테이징 (git add -A). 비밀(.env·토큰·credentials·*.db)은 .gitignore가 제외 → 사고 방지
# - 변경(신규 포함) 없으면 조용히 종료
# - 항상 exit 0 (Stop 훅이 세션 종료를 막지 않도록)
HOMI_DIR="/Users/mac_ad03249840/Developer/homi"

cd "$HOMI_DIR" 2>/dev/null || exit 0

# 변경(신규 파일 포함)이 없으면 아무것도 안 함
[ -n "$(git status --porcelain 2>/dev/null)" ] || exit 0

git add -A 2>/dev/null
git commit -m "auto: 워킹트리 자동 커밋 ($(date '+%Y-%m-%d %H:%M'))" >/dev/null 2>&1 || exit 0

# 푸시 실패는 무시 (다음 커밋 때 함께 올라감)
git push >/dev/null 2>&1

exit 0
