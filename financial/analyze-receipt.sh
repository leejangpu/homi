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
if ! RAW=$(claude -p --setting-sources project,local --model claude-sonnet-4-6 --dangerously-skip-permissions --allowedTools "Read" --add-dir "$SCRIPT_DIR/tmp" < "$PROMPT_FILE" 2>&1); then
  echo "Claude CLI 실패 (출력 내용):"
  echo "$RAW"
  rm -f "$PROMPT_FILE"
  exit 1
fi
rm -f "$PROMPT_FILE"

echo "▶ 분석 결과:"
echo "$RAW"

# 영수증 항목에 등장한 모든 월(unique, 정렬) 추출 — 한 영수증에 여러 달 섞여도 분리 처리
DETECTED_MONTHS=$(python3 - "$RAW" << 'PYEOF'
import json, sys
try:
    items = json.loads(sys.argv[1])
    months = sorted({item['날짜'].split('.')[0].zfill(2) for item in items if '날짜' in item and '.' in item['날짜']})
    print(' '.join(months))
except Exception:
    pass
PYEOF
)

if [ -z "$DETECTED_MONTHS" ]; then
  DETECTED_MONTHS="$MONTH"
fi

echo "▶ expense_detail.json + CSV 업데이트 (월별 분리: ${DETECTED_MONTHS})"
python3 "$SCRIPT_DIR/update-expense.py" "$YEAR" "$MONTH" "$RAW"

for m in $DETECTED_MONTHS; do
  echo "▶ AI 리포트 재생성: ${YEAR}-${m}"
  bash "$SCRIPT_DIR/generate-report.sh" "$YEAR" "$m"
done

echo "✓ 영수증 분석 완료"
