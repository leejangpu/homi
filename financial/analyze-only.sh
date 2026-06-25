#!/usr/bin/env bash
# 영수증/명세서 파일을 Claude로 분석해 지출 항목 JSON만 stdout에 출력한다.
# (analyze-receipt.sh와 달리 시트/CSV/리포트에 저장하지 않음 — 대화형 검토 플로우용)
set -euo pipefail

FILE_NAME="${1:?파일명 필요 (예: receipt-1234.pdf)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE_PATH="$SCRIPT_DIR/tmp/$FILE_NAME"

if [ ! -f "$FILE_PATH" ]; then
  echo "오류: 파일을 찾을 수 없습니다: $FILE_PATH" >&2
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

PROMPT_FILE=$(mktemp)
printf '%s' "$CLAUDE_PROMPT" > "$PROMPT_FILE"
RAW=$(claude -p --setting-sources project,local --model claude-sonnet-4-6 --dangerously-skip-permissions --allowedTools "Read" --add-dir "$SCRIPT_DIR/tmp" < "$PROMPT_FILE" 2>/dev/null) || {
  rm -f "$PROMPT_FILE"
  echo "오류: Claude 분석 실패" >&2
  exit 1
}
rm -f "$PROMPT_FILE"

# JSON 배열만 출력 (코드블록 감싸짐 제거)
printf '%s' "$RAW"
