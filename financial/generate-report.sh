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

# 기존 summary.json에서 이전 리포트 컨텍스트 추출 (Node.js)
PREV_REPORT_CONTEXT=$(node -e "
const fs = require('fs');
const p = '$SUMMARY_PATH';
if (!fs.existsSync(p)) { process.exit(0); }
const s = JSON.parse(fs.readFileSync(p,'utf-8'));
const yearData = s['$YEAR'] || {};

// 현재 달 기존 리포트 (업데이트 이전 상태)
const curReport = yearData['$MN'];
// 전달 리포트
const prevReport = yearData['$PREV_MONTH'];

// 연간 전체 흐름 (모든 달 요약)
const months = Object.keys(yearData).sort();
const yearSummary = months.map(m => {
  const r = yearData[m];
  // HTML 태그 제거해서 텍스트만 추출
  const text = r.summary ? r.summary.replace(/<[^>]+>/g, '') : '';
  return m + '월: ' + text.substring(0, 300).replace(/\n/g, ' ');
}).join('\n');

let out = '';
if (curReport && curReport.summary) {
  const curText = curReport.summary.replace(/<[^>]+>/g, '');
  out += '=== 이번 달(' + '$MN' + '월) 업데이트 이전 기존 리포트 ===\n' + curText + '\n\n';
}
if (prevReport && prevReport.summary) {
  const prevText = prevReport.summary.replace(/<[^>]+>/g, '');
  out += '=== 전달(' + '$PREV_MONTH' + '월) 리포트 ===\n' + prevText + '\n\n';
}
if (yearSummary) {
  out += '=== ${YEAR}년 월별 흐름 요약 ===\n' + yearSummary + '\n';
}
process.stdout.write(out);
" 2>/dev/null || true)

# 다음 달 비정기지출 추출 (CSV에서 비정기지출 섹션 파싱)
NEXT_MONTH=$(printf "%02d" $((MONTH + 1 > 12 ? 1 : MONTH + 1)))
NEXT_YEAR=$((MONTH + 1 > 12 ? YEAR + 1 : YEAR))
NEXT_MONTH_NUM=$((MONTH + 1 > 12 ? 1 : MONTH + 1))

UPCOMING_IR=$(python3 -c "
import csv, re, sys

csv_path = '${SCRIPT_DIR}/${YEAR}.csv'
try:
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        rows = list(csv.reader(f))
except:
    sys.exit(0)

next_month = ${NEXT_MONTH_NUM}
items = []
for r in rows:
    c1 = r[1].strip() if len(r)>1 else ''
    c2 = r[2].strip() if len(r)>2 else ''
    if c1 == '비정기지출' and c2:
        # Find which month column has data
        for j in range(4, min(16, len(r))):
            val = r[j].strip()
            if val and val != '0':
                # Header row should have month label at col j
                header = rows[0]
                label = header[j].strip() if j < len(header) else ''
                m = re.search(r'-(\d{2})$', label)
                if m and int(m.group(1)) == next_month:
                    items.append(f'{c2}: {val}원')
for item in items:
    print(item)
" 2>/dev/null)

if [ -n "$UPCOMING_IR" ]; then
  NEXT_MONTH_NOTE="
[다음 달(${NEXT_YEAR}년 ${NEXT_MONTH_NUM}월) 비정기지출 예정]
${UPCOMING_IR}
위 항목들을 반드시 리포트 마지막에 '⚠️ 다음 달 비정기지출 예고' 섹션으로 언급하여 미리 알려줘."
else
  NEXT_MONTH_NOTE=""
fi

# expense_detail.json에서 메모 있는 항목 추출
EXPENSE_MEMOS=$(node -e "
const fs = require('fs');
const p = '${SCRIPT_DIR}/expense_detail.json';
if (!fs.existsSync(p)) process.exit(0);
const d = JSON.parse(fs.readFileSync(p,'utf-8'));
const monthData = (d['${YEAR}'] || {})['${MN}'] || {};
const items = monthData.items || [];
const withMemo = items.filter(i => i.메모 && i.메모.trim());
if (!withMemo.length) process.exit(0);
const lines = withMemo.map(i => '  - ' + i.날짜 + ' ' + i.가맹점 + ' ' + parseInt(i.금액).toLocaleString() + '원 [' + i.카테고리 + ']: ' + i.메모);
process.stdout.write(lines.join('\n'));
" 2>/dev/null)

if [ -n "$EXPENSE_MEMOS" ]; then
  EXPENSE_MEMO_NOTE="

[${YEAR}년 ${MN}월 지출 세부 메모 — 직접 기록한 내역]
아래 항목은 각 지출에 직접 작성한 메모입니다. 분석 시 참고하여 구체적인 지출 내용을 언급하세요:
${EXPENSE_MEMOS}"
else
  EXPENSE_MEMO_NOTE=""
fi

# Claude CLI로 리포트 생성
REPORT_PROMPT_FILE=$(mktemp)
cat > "$REPORT_PROMPT_FILE" <<PROMPT
너는 대한민국 재무장관이다. 가계 재정을 엄격하게 감독하고 지출에 냉혹한 평가를 내린다.
아래 CSV 데이터와 이전 리포트 컨텍스트를 바탕으로 ${YEAR}년 ${MONTH}월 월간 브리핑을 작성해라.

[출력 형식 — 반드시 준수]
- 마크다운 절대 사용 금지: **, *, ##, ---, > 등 모든 마크다운 문법 사용 불가
- HTML span 태그만 허용 (아래 4가지만):
  - 증가/긍정: <span class="up-color">내용</span>
  - 감소/부정: <span class="down-color">내용</span>
  - 경고: <span class="warn">내용</span>
  - 강조: <span class="highlight">내용</span>
- 줄바꿈: <br> 태그만 사용
- 섹션 제목: <span class="highlight">📌 제목</span><br> 형식
- 코드블록·JSON·마크다운 감싸기 없이 본문만 출력
- 금액: 10,000원 단위 이상은 한글 단위 (100만원, 500만원, 1억원). 단수 금액은 숫자 그대로

[분량 원칙 — 반드시 준수]
- 섹션당 핵심 3줄 이내. 장황한 설명 금지.
- 수치는 꼭 필요한 것만. 전월 대비 변화량과 퍼센트 위주로만.
- 잘 알려진 사실 반복 금지. 새 정보나 평가만 쓸 것.

[작성 내용 — 두 섹션]

섹션 1: 월간 브리핑 (컴팩트)
- 소득·지출·저축·잔액을 전월 대비 변화 중심으로 수치만 간결하게
- 특이사항(인센티브, 비정기지출 등) 한 줄로 원인만
- 올해 전체 흐름(이전 달들 대비) 한 줄 평가
- 다음 달 주의사항 한 줄

섹션 2: 재무장관 지시 (구분선: <br><span class="highlight">── 재무장관 지시 ──</span><br>)
전제: 2026~2036년 10년 내 순자산 15억 달성이 목표다.

재무장관으로서 단호하고 엄중하게 작성한다:
- 이번 달 지출 중 문제가 된 항목을 구체적 금액으로 지적하고 상한액을 명령하라.
- 이전 달에 지시한 사항이 이번 달에 지켜졌는지 평가하라 (개선/미이행/악화 판정).
- 지금 당장 해야 할 행동 2가지만 (간결하게 명령형으로).
- 10년 목표 달성 가능성 판단 한 줄 (수치 근거 포함).

[참고 컨텍스트 — 이전 리포트]
${PREV_REPORT_CONTEXT}

아래는 ${YEAR}년 가계부 CSV 데이터입니다. ${PREV_YEAR}년 ${PREV_MONTH}월과 ${YEAR}년 ${MN}월을 비교 분석한 월간 브리핑을 작성해줘.
${NEXT_MONTH_NOTE}
${EXPENSE_MEMO_NOTE}

${CSV_DATA}
PROMPT
if ! REPORT=$(claude -p --setting-sources project,local --model claude-sonnet-4-6 --dangerously-skip-permissions < "$REPORT_PROMPT_FILE" 2>&1); then
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
