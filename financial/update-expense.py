#!/usr/bin/env python3
"""
영수증 분석 결과를 expense_detail.json과 2026.csv에 반영합니다.
사용법: python3 update-expense.py YEAR MONTH JSON_STRING
"""
import sys
import json
import csv
import os
from datetime import datetime
from io import StringIO

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXPENSE_DETAIL_PATH = os.path.join(SCRIPT_DIR, "expense_detail.json")

EXCLUDE_CATEGORIES = {"제외"}


def parse_items(raw_json: str) -> list:
    raw = raw_json.strip()
    # Claude가 가끔 코드블록으로 감싸는 경우 제거
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1])
    return json.loads(raw)


def update_expense_detail(year: str, month: str, new_items: list):
    detail = {}
    if os.path.exists(EXPENSE_DETAIL_PATH):
        with open(EXPENSE_DETAIL_PATH, "r", encoding="utf-8") as f:
            detail = json.load(f)

    if year not in detail:
        detail[year] = {}
    if month not in detail[year]:
        detail[year][month] = {"items": [], "카테고리별 합계": {}, "메모": ""}

    entry = detail[year][month]
    if "items" not in entry:
        entry["items"] = []

    source = f"receipt-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    for item in new_items:
        item["source"] = source
    entry["items"].extend(new_items)

    # 카테고리별 합계 재계산 (제외 카테고리 제외)
    totals: dict[str, int] = {}
    for item in entry["items"]:
        cat = item.get("카테고리", "기타(메모입력)")
        if cat in EXCLUDE_CATEGORIES:
            continue
        totals[cat] = totals.get(cat, 0) + int(item.get("금액", 0))
    entry["카테고리별 합계"] = totals

    with open(EXPENSE_DETAIL_PATH, "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=2)

    print(f"✓ expense_detail.json: {len(new_items)}개 항목 추가")
    return totals


def parse_amount(s) -> int:
    if not s:
        return 0
    return int(str(s).replace("₩", "").replace(",", "").strip() or "0")


def format_amount(n: int) -> str:
    if n == 0:
        return ""
    return f"{n:,}"


def update_csv(year: str, month: str, cat_totals: dict):
    csv_path = os.path.join(SCRIPT_DIR, f"{year}.csv")
    if not os.path.exists(csv_path):
        print(f"경고: {csv_path} 파일이 없어 CSV 업데이트를 건너뜁니다.")
        return

    with open(csv_path, "r", encoding="utf-8-sig") as f:
        content = f.read()

    rows = list(csv.reader(StringIO(content)))

    # 헤더 행에서 월 컬럼 인덱스 찾기
    col_idx = None
    target_col = f"{year}-{month}"
    for row in rows:
        for i, cell in enumerate(row):
            if cell.strip() == target_col:
                col_idx = i
                break
        if col_idx is not None:
            break

    if col_idx is None:
        print(f"경고: '{target_col}' 컬럼을 찾을 수 없어 CSV 업데이트를 건너뜁니다.")
        return

    # 변동지출 섹션에서 카테고리 행 업데이트
    in_variable = False
    updated_cats: set = set()

    for i, row in enumerate(rows):
        if len(row) < 3:
            continue
        col1 = row[1].strip()
        col2 = row[2].strip()

        if col1 == "변동지출":
            in_variable = True
        elif col1 in ("비정기지출", "계") and in_variable:
            in_variable = False

        if in_variable and col2 in cat_totals:
            while len(row) <= col_idx:
                row.append("")
            row[col_idx] = format_amount(cat_totals[col2])
            updated_cats.add(col2)
            rows[i] = row

    # 새 카테고리 행 삽입 (변동지출 섹션 마지막, 비정기지출 앞)
    new_cats = set(cat_totals.keys()) - updated_cats
    if new_cats:
        insert_idx = None
        past_variable = False
        for i, row in enumerate(rows):
            if len(row) < 2:
                continue
            col1 = row[1].strip()
            if col1 == "변동지출":
                past_variable = True
            if past_variable and col1 in ("비정기지출", "계"):
                insert_idx = i
                break

        if insert_idx is not None:
            for cat in sorted(new_cats):
                new_row = [""] * max(col_idx + 1, 20)
                new_row[2] = cat
                new_row[3] = "공통"
                new_row[col_idx] = format_amount(cat_totals[cat])
                rows.insert(insert_idx, new_row)
                insert_idx += 1

    # 지출 계 재계산
    recalculate_expense_total(rows, col_idx)

    # CSV 저장 (BOM 포함)
    output = StringIO()
    writer = csv.writer(output, lineterminator="\n")
    for row in rows:
        writer.writerow(row)

    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(output.getvalue())

    print(f"✓ {year}.csv 업데이트: {len(updated_cats)}개 기존 카테고리, {len(new_cats)}개 신규")


def recalculate_expense_total(rows: list, col_idx: int):
    """지출 섹션의 계 행과 잔액 행을 재계산합니다."""
    in_expense = False
    expense_rows: list[int] = []
    expense_total_idx = None

    for i, row in enumerate(rows):
        if len(row) < 2:
            continue
        col1 = row[1].strip()

        if col1 == "지출":
            in_expense = True
            continue

        if in_expense:
            if col1 == "계":
                expense_total_idx = i
                in_expense = False
            elif col1 not in ("자산(월말업데이트",):
                expense_rows.append(i)

    if expense_total_idx is None:
        return

    # 지출 합계
    total = sum(parse_amount(rows[i][col_idx]) for i in expense_rows if len(rows[i]) > col_idx)

    row = rows[expense_total_idx]
    while len(row) <= col_idx:
        row.append("")
    row[col_idx] = format_amount(total) if total else ""
    rows[expense_total_idx] = row

    # 잔액 재계산: 소득계 - 저축계 - 지출계
    totals_found: list[int] = []
    for i, row in enumerate(rows):
        if len(row) > 1 and row[1].strip() == "계" and len(row) > col_idx:
            totals_found.append(parse_amount(row[col_idx]))
            if len(totals_found) == 3:
                break

    if len(totals_found) >= 3:
        잔액 = totals_found[0] - totals_found[1] - totals_found[2]
        for i, row in enumerate(rows):
            if len(row) > 1 and "잔액" in row[1]:
                while len(row) <= col_idx:
                    row.append("")
                row[col_idx] = format_amount(잔액) if 잔액 != 0 else ""
                rows[i] = row
                break


def main():
    if len(sys.argv) < 4:
        print("사용법: python3 update-expense.py YEAR MONTH JSON_STRING")
        sys.exit(1)

    year = sys.argv[1]
    month = sys.argv[2].zfill(2)
    raw_json = sys.argv[3]

    items = parse_items(raw_json)
    print(f"✓ 파싱된 항목: {len(items)}개")

    cat_totals = update_expense_detail(year, month, items)
    update_csv(year, month, cat_totals)


if __name__ == "__main__":
    main()
