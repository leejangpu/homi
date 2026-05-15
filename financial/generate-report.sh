#!/bin/bash
# AI 월간 브리핑 리포트 생성
# 사용법: ./generate-report.sh [year] [month]
# 예시: ./generate-report.sh 2026 4

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YEAR="${1:-$(date +%Y)}"
MONTH="${2:-$(date +%-m)}"
MN=$(printf "%02d" "$MONTH")

if [ "$MONTH" -eq 1 ]; then
  PREV_YEAR=$((YEAR - 1))
  PREV_MONTH="12"
else
  PREV_YEAR="$YEAR"
  PREV_MONTH=$(printf "%02d" $((MONTH - 1)))
fi

CSV_PATH="$SCRIPT_DIR/${YEAR}.csv"
SUMMARY_PATH="$SCRIPT_DIR/summary.json"

if [ ! -f "$CSV_PATH" ]; then
  echo "❌ ${YEAR}.csv 파일이 없습니다"
  exit 1
fi

echo "📊 ${YEAR}년 ${MONTH}월 AI 브리핑 생성 중..."

# CSV 데이터 준비
CSV_DATA=$(cat "$CSV_PATH")
if [ "$MONTH" -eq 1 ] && [ -f "$SCRIPT_DIR/${PREV_YEAR}.csv" ]; then
  PREV_CSV=$(cat "$SCRIPT_DIR/${PREV_YEAR}.csv")
  CSV_DATA="=== ${PREV_YEAR}년 데이터 ===
${PREV_CSV}

=== ${YEAR}년 데이터 ===
${CSV_DATA}"
fi

# Claude CLI로 리포트 생성
REPORT_PROMPT_FILE=$(mktemp)
cat > "$REPORT_PROMPT_FILE" <<PROMPT
너는 가계부 데이터를 분석하는 금융 어드바이저야. 아래 CSV 데이터를 분석해서 월간 AI 브리핑 리포트를 작성해줘.

[출력 형식 — 반드시 준수]
- 마크다운 절대 사용 금지: **, *, ##, ---, >, ` 등 모든 마크다운 문법 사용 불가
- HTML span 태그만 허용: 아래 4가지만 사용
  - 증가/긍정: <span class="up-color">내용</span>
  - 감소/부정: <span class="down-color">내용</span>
  - 경고: <span class="warn">내용</span>
  - 강조: <span class="highlight">내용</span>
- 줄바꿈: <br> 태그만 사용 (줄바꿈 문자 \n 사용 가능, 단 마크다운 헤더/목록/구분선 불가)
- 섹션 제목: <span class="highlight">📌 소득</span><br> 형식으로 작성
- 코드블록, JSON, 마크다운 감싸기 없이 본문만 출력

[작성 내용]
- 전월 대비 소득, 저축, 지출 변화를 항목별로 구체적 금액과 퍼센트로 분석
- 특이사항(인센티브, 비정기지출 등) 원인 파악
- 마지막에 다음 달 주의사항 포함
- 은퇴 플랜 코칭은 포함 금지 (별도 생성됨)
- 한국어 작성

아래는 ${YEAR}년 가계부 CSV 데이터입니다. ${PREV_YEAR}년 ${PREV_MONTH}월과 ${YEAR}년 ${MN}월을 비교 분석한 월간 브리핑을 작성해줘.

${CSV_DATA}
PROMPT
if ! REPORT=$(claude -p --model claude-sonnet-4-6 --dangerously-skip-permissions < "$REPORT_PROMPT_FILE" 2>&1); then
  echo "❌ Claude CLI 실패:"
  echo "$REPORT"
  rm -f "$REPORT_PROMPT_FILE"
  exit 1
fi
rm -f "$REPORT_PROMPT_FILE"

if [ -z "$REPORT" ]; then
  echo "❌ Claude CLI 응답이 비어있습니다"
  exit 1
fi

# 마크다운 제거 (코드블록, 헤더, 굵게, 수평선)
REPORT=$(echo "$REPORT" | sed '/^```/d')
REPORT=$(echo "$REPORT" | sed 's/^#{1,4} //g')
REPORT=$(echo "$REPORT" | sed 's/\*\*\([^*]*\)\*\*/<strong>\1<\/strong>/g')
REPORT=$(echo "$REPORT" | sed '/^---*$/d')

# trend 판단
TREND="neutral"
if echo "$REPORT" | grep -q "up-color"; then
  if ! echo "$REPORT" | grep -q "down-color"; then
    TREND="up"
  fi
elif echo "$REPORT" | grep -q "down-color"; then
  TREND="down"
fi

# summary.json 업데이트 (Node.js 한 줄로)
node -e "
const fs = require('fs');
const p = '$SUMMARY_PATH';
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf-8')) : {};
if (!s['$YEAR']) s['$YEAR'] = {};
s['$YEAR']['$MN'] = {
  date: new Date().toISOString().split('T')[0],
  period: '${MN}월',
  trend: '$TREND',
  summary: fs.readFileSync('/dev/stdin','utf-8').trim()
};
fs.writeFileSync(p, JSON.stringify(s, null, 2));
" <<< "$REPORT"

echo "✅ summary.json 업데이트 완료"

# Git commit & push
cd "$SCRIPT_DIR"
git add summary.json
if git diff --staged --quiet; then
  echo "ℹ️ 변경사항 없음"
else
  git commit -m "${YEAR}년 ${MONTH}월 AI 브리핑 리포트 생성"
  git pull --rebase --autostash
  git push
  echo "✅ Git push 완료"
fi
