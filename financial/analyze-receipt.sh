#!/usr/bin/env bash
set -euo pipefail

YEAR="${1:?연도 필요 (예: 2026)}"
MONTH="${2:?월 필요 (예: 05)}"
FILE_NAME="${3:?파일명 필요 (예: receipt-1234.pdf)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE_PATH="$SCRIPT_DIR/tmp/$FILE_NAME"

if [ ! -f "$FILE_PATH" ]; then
  echo "오류: 파일을 찾을 수 없습니다: $FILE_PATH"
  exit 1
fi

CATEGORIES="외식/카페, 생활비, 쇼핑, 통신비, 관리비, 도시가스, 유류비, 콘텐츠, 의료, 교통, 경조사비, 여가/레저, 기타(메모입력), 제외"

CLAUDE_PROMPT="당신은 한국 카드 명세서 파싱 전문가입니다.
Read 도구를 사용해서 다음 경로의 파일을 읽고 모든 지출 항목을 추출하세요.

파일 경로: $FILE_PATH

반환 형식: JSON 배열만 (마크다운 없이, 설명 없이)
예시: [{\"날짜\":\"05.03\",\"가맹점\":\"스타벅스\",\"카드\":\"삼성카드\",\"금액\":8500,\"카테고리\":\"외식/카페\"}]

카테고리는 반드시 다음 중 하나: ${CATEGORIES}
규칙:
- 취소/환불/포인트 적립 항목 제외
- 금액은 양수 정수 (원 단위)
- 날짜는 MM.DD 형식
- 항목이 없으면 [] 반환
- 최종 답변은 JSON 배열만 출력 (다른 텍스트 없이)
- 금액이 0원으로 표시된 항목은 사전 정산된 것이므로, 해당 항목 하단에 작게 표시된 '입금금액'을 실제 금액으로 사용하세요"

echo "▶ Claude CLI로 영수증 분석 중: $FILE_NAME"
PROMPT_FILE=$(mktemp)
printf '%s' "$CLAUDE_PROMPT" > "$PROMPT_FILE"
if ! RAW=$(claude -p --model claude-sonnet-4-6 --dangerously-skip-permissions --allowedTools "Read" --add-dir "$SCRIPT_DIR/tmp" < "$PROMPT_FILE" 2>&1); then
  echo "Claude CLI 실패 (출력 내용):"
  echo "$RAW"
  rm -f "$PROMPT_FILE"
  exit 1
fi
rm -f "$PROMPT_FILE"

echo "▶ 분석 결과:"
echo "$RAW"

# 영수증 날짜에서 월 자동 감지 (항목 날짜의 최빈 월 사용)
DETECTED_MONTH=$(python3 - "$RAW" << 'PYEOF'
import json, sys
from collections import Counter
try:
    items = json.loads(sys.argv[1])
    months = [item['날짜'].split('.')[0].zfill(2) for item in items if '날짜' in item and '.' in item['날짜']]
    if months:
        most_common = Counter(months).most_common(1)[0][0]
        print(most_common)
    else:
        import sys as s; s.exit(1)
except Exception as e:
    import sys as s; s.exit(1)
PYEOF
)

if [ -n "$DETECTED_MONTH" ] && [ "$DETECTED_MONTH" != "$MONTH" ]; then
  echo "▶ 월 자동 감지: 입력값(${MONTH}) → 영수증 날짜 기준(${DETECTED_MONTH})으로 변경"
  MONTH="$DETECTED_MONTH"
fi

echo "▶ expense_detail.json + CSV 업데이트"
python3 "$SCRIPT_DIR/update-expense.py" "$YEAR" "$MONTH" "$RAW"

echo "▶ AI 리포트 재생성"
bash "$SCRIPT_DIR/generate-report.sh" "$YEAR" "$MONTH"

echo "✓ 영수증 분석 완료"
