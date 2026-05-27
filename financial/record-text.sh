#!/usr/bin/env bash
# 음성/텍스트 가계부 입력을 파싱해서 expense_detail.json + CSV에 반영
# 사용법: ./record-text.sh "5월 23일 쇼핑 3만원"

set -uo pipefail

TEXT="${1:-}"
if [ -z "$TEXT" ]; then
  echo "Usage: $0 <text>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../infinite-buy/.env"

TG_TOKEN=""
TG_CHAT=""
if [ -f "$ENV_FILE" ]; then
  TG_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  TG_CHAT=$(grep '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)
fi

notify() {
  local msg="$1"
  if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d "chat_id=${TG_CHAT}" \
      --data-urlencode "text=${msg}" > /dev/null || true
  fi
}

TODAY_KST=$(TZ=Asia/Seoul date +%Y-%m-%d)
YEAR=$(echo "$TODAY_KST" | cut -d- -f1)
MONTH_DEFAULT=$(echo "$TODAY_KST" | cut -d- -f2)
TODAY_MMDD=$(echo "$TODAY_KST" | awk -F- '{print $2"."$3}')

CATEGORIES="외식/카페, 생활비, 쇼핑, 통신비, 관리비, 도시가스, 유류비, 콘텐츠, 의료, 교통, 경조사비, 여가/레저, 기타(메모입력)"

PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<PROMPT
당신은 가계부 음성/텍스트 입력 파서입니다.
오늘 날짜는 ${TODAY_KST} (KST)입니다.

[입력]
${TEXT}

[출력 형식]
JSON 배열만 출력. 코드블록, 설명, 그 외 텍스트 절대 없이.
예시: [{"날짜":"05.03","가맹점":"스타벅스","카드":"","금액":8500,"카테고리":"외식/카페","메모":"원본 텍스트"}]

[규칙]
- 가장 중요: 입력이 가계부 지출 항목으로 명확히 해석되지 않으면 빈 배열 [] 반환. 다음의 경우 무조건 [] 반환:
  · 금액이 명시되지 않았거나 추정 불가
  · 받아쓰기 오류로 의미 불명확 (예: "스타벅스 갔다" 처럼 금액 없음, "어쩌고 저쩌고" 같이 뜻 안 통함)
  · 가계부와 무관한 내용 (질문, 감상, 인사 등)
  · 받아쓰기 결과가 횡설수설하거나 문맥이 깨진 경우
  애매하면 무조건 []. 잘못 기록하느니 무시가 낫습니다.
- 날짜: 입력에서 추출. 명시 없으면 오늘(${TODAY_MMDD}) 사용. 형식은 MM.DD
- 가맹점: 명시되면 그대로, 없으면 "음성기록"
- 카드: 명시 없으면 빈 문자열
- 금액: 양수 정수 원 단위. "3만원"→30000, "1.5만"→15000, "삼만"→30000, "오천원"→5000
- 카테고리: 다음 중 정확히 하나만 사용 — ${CATEGORIES}. 분명하지 않으면 "기타(메모입력)"
- 메모: 입력 텍스트 그대로
- 한 입력에 지출 여러 건이면 객체 여러 개로 배열에 담기
- 출력은 JSON 배열 그 자체만
PROMPT

RAW=$(claude -p --setting-sources project,local --model claude-sonnet-4-6 --dangerously-skip-permissions < "$PROMPT_FILE" 2>&1)
CLAUDE_RC=$?
rm -f "$PROMPT_FILE"

if [ $CLAUDE_RC -ne 0 ]; then
  notify "❌ 가계부 기록 실패 (Claude 호출 오류)
입력: ${TEXT}
오류: $(echo "$RAW" | tail -c 500)"
  echo "Claude 실패: $RAW" >&2
  exit 1
fi

# 코드블록/공백 정리
RAW=$(echo "$RAW" | sed -E '/^```/d')
RAW=$(echo "$RAW" | awk 'NF' | tr -d '\r')
RAW=$(echo "$RAW" | python3 -c "import sys; s=sys.stdin.read().strip(); print(s)")

echo "Parsed: $RAW"

# JSON 유효성 + 월 감지
DETECTED_MONTH=$(python3 - "$RAW" <<'PYEOF' 2>/dev/null
import json, sys
from collections import Counter
try:
    items = json.loads(sys.argv[1])
    months = [item['날짜'].split('.')[0].zfill(2) for item in items if '날짜' in item and '.' in item['날짜']]
    if months:
        print(Counter(months).most_common(1)[0][0])
except Exception:
    sys.exit(1)
PYEOF
)

if ! echo "$RAW" | python3 -c "import json,sys; json.loads(sys.stdin.read())" >/dev/null 2>&1; then
  notify "❌ 가계부 기록 실패 (JSON 파싱 오류)
입력: ${TEXT}
응답: $(echo "$RAW" | head -c 500)"
  exit 1
fi

ITEM_COUNT=$(echo "$RAW" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))")
if [ "$ITEM_COUNT" = "0" ]; then
  notify "⚠️ 가계부 입력 무시
입력: ${TEXT}
이유: 지출 항목으로 해석되지 않음 (받아쓰기 오류 가능)"
  echo "무시: $TEXT"
  exit 0
fi

MONTH="${DETECTED_MONTH:-$MONTH_DEFAULT}"

UPDATE_OUT=$(python3 "$SCRIPT_DIR/update-expense.py" "$YEAR" "$MONTH" "$RAW" 2>&1)
UPDATE_RC=$?
if [ $UPDATE_RC -ne 0 ]; then
  notify "❌ 가계부 기록 실패 (CSV 업데이트 오류)
입력: ${TEXT}
오류: $(echo "$UPDATE_OUT" | tail -c 500)"
  echo "update-expense 실패: $UPDATE_OUT" >&2
  exit 1
fi

SUMMARY=$(python3 - "$RAW" <<'PYEOF'
import json, sys
items = json.loads(sys.argv[1])
lines = []
for it in items:
    amount = "{:,}원".format(int(it.get('금액', 0)))
    lines.append(f"• {it.get('날짜','')} [{it.get('카테고리','-')}] {it.get('가맹점','')} {amount}")
print("\n".join(lines))
PYEOF
)

notify "✅ 가계부 ${YEAR}-${MONTH} 기록됨
${SUMMARY}

원본: ${TEXT}"

echo "✓ 기록 완료"
