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

PROMPT="당신은 한국 카드 명세서 파싱 전문가입니다.
첨부된 파일(카드 명세서 PDF 또는 이미지)에서 모든 지출 항목을 추출하세요.

반환 형식: JSON 배열만 (마크다운 없이, 설명 없이)
예시: [{\"날짜\":\"05.03\",\"가맹점\":\"스타벅스\",\"카드\":\"삼성카드\",\"금액\":8500,\"카테고리\":\"외식/카페\"}]

카테고리는 반드시 다음 중 하나: ${CATEGORIES}
규칙:
- 취소/환불/포인트 적립 항목 제외
- 금액은 양수 정수 (원 단위)
- 날짜는 MM.DD 형식
- 항목이 없으면 [] 반환"

echo "▶ Claude CLI로 영수증 분석 중: $FILE_NAME"
RAW=$(claude -p --model claude-sonnet-4-6 --bare "$PROMPT" "$FILE_PATH")

echo "▶ 분석 결과:"
echo "$RAW"

echo "▶ expense_detail.json + CSV 업데이트"
python3 "$SCRIPT_DIR/update-expense.py" "$YEAR" "$MONTH" "$RAW"

echo "▶ AI 리포트 재생성"
bash "$SCRIPT_DIR/generate-report.sh" "$YEAR" "$MONTH"

echo "✓ 영수증 분석 완료"
