#!/usr/bin/env python3
"""
삼성카드 VestMail 보안 HTML 첨부를 Playwright로 복호화합니다.

사용법:
    python decrypt_samsungcard.py tmp/samsungcard_20260513.html 890902
    python decrypt_samsungcard.py tmp/samsungcard_20260513.html 890902 --debug

동작 원리 (타이밍 추측이 아니라 '실제 데이터가 나타났는지'로 판정):
- 비번 제출(#confirm) 시 폼(#decForm)이 bill.samsungcard.com 명세서 뷰어로 navigate 한다.
- 뷰어 페이지의 #bldFrame div에 명세서 본문이 비동기로 채워진다. 외부 JS 체인을
  거치느라 **렌더 완료까지 30~60초**가 걸린다(빠른 PC라도 느림).
- 따라서 고정 대기시간이 아니라, #bldFrame에 실제 금액(예: "12,345원")이
  N건 이상 나타날 때까지 폴링한다. 비번이 틀리면 navigate 자체가 안 되고
  같은 페이지에 오류 문구가 뜬다 → 그걸로 구분.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def stage(name: str):
    """진행 단계를 stdout으로 알림 (server.js가 파싱해 UI에 표시). 즉시 flush."""
    print(f"@@STAGE:{name}", flush=True)


AMOUNT_RE = re.compile(r"[0-9]{1,3}(?:,[0-9]{3})+\s*원")
RENDER_TIMEOUT_S = 90      # 렌더 완료까지 최대 대기 (느린 뷰어 대비 넉넉히)
MIN_AMOUNTS = 5            # 이 개수 이상의 금액이 보이면 '본문 채워짐'으로 판정
POLL_INTERVAL_MS = 2000


def collect_text(page) -> str:
    """#bldFrame(신규 뷰어) 우선, 없으면 body + 모든 frame 텍스트(구 자체완결형)."""
    parts = []
    try:
        bld = page.evaluate(
            "() => {const d=document.getElementById('bldFrame');return d?(d.innerText||''):''}"
        )
        if bld:
            parts.append(bld)
    except Exception:
        pass
    if not parts:
        try:
            parts.append(page.evaluate("() => document.body ? (document.body.innerText||'') : ''"))
        except Exception:
            pass
        for frame in page.frames:
            try:
                t = frame.evaluate("() => document.body ? (document.body.innerText||'') : ''")
                if t and len(t) > 50:
                    parts.append(t)
            except Exception:
                pass
    return "\n".join(parts)


def wait_for_statement(page, debug=False) -> str:
    """본문에 실제 금액이 MIN_AMOUNTS건 이상 나타날 때까지 폴링. 채워진 텍스트 반환."""
    t0 = time.time()
    last = ""
    while time.time() - t0 < RENDER_TIMEOUT_S:
        page.wait_for_timeout(POLL_INTERVAL_MS)
        last = collect_text(page)
        n = len(AMOUNT_RE.findall(last))
        if debug:
            print(f"[debug] {time.time()-t0:4.0f}s  텍스트{len(last)}자  금액{n}건", file=sys.stderr)
        if n >= MIN_AMOUNTS:
            # 채워진 직후 잔여 행이 더 붙을 수 있어 한 번 더 안정화
            page.wait_for_timeout(3000)
            return collect_text(page)
    return last


def _row_count(page) -> int:
    """현재 펼쳐진 개별 거래 행 수 추정('내용 더 보기' 토글 개수)."""
    try:
        return page.evaluate(
            r"() => ((document.getElementById('bldFrame')||document.body)"
            r".innerText.match(/내용\s*더\s*보기/g)||[]).length"
        )
    except Exception:
        return 0


def expand_pagination(page, debug=False):
    """거래목록이 10건 단위로 페이지네이션되어 'more_view_arr' 더보기 버튼 뒤에
    나머지 거래가 숨는다. 보이는 더보기 버튼을 모두 사라질 때까지 눌러
    전체 거래가 캡처에 포함되게 한다. (안 누르면 11건 중 대형 1건 누락 사례 발생)"""
    for i in range(20):  # 안전 상한
        btn = page.query_selector("#bldFrame button.more_view_arr")
        if not btn or not btn.is_visible():
            break
        before = _row_count(page)
        try:
            btn.scroll_into_view_if_needed()
            btn.click()
        except Exception:
            break
        # 행이 늘어날 때까지 대기 (비동기 로드)
        grew = False
        for _ in range(15):
            page.wait_for_timeout(700)
            if _row_count(page) > before:
                grew = True
                break
        if debug:
            print(f"[debug] 더보기 클릭{i+1}: {before} → {_row_count(page)}행", file=sys.stderr)
        if not grew:
            break  # 더 안 늘면 중단 (무한루프 방지)


def decrypt(html_path: str, password: str, debug: bool = False):
    html_path = os.path.abspath(html_path)
    if not os.path.exists(html_path):
        print(f"오류: HTML 파일 없음 {html_path}", file=sys.stderr)
        sys.exit(1)

    base = os.path.splitext(os.path.basename(html_path))[0]
    tmp_dir = os.path.dirname(html_path)
    out_pdf = os.path.join(tmp_dir, f"{base}_decrypted.pdf")
    out_html = os.path.join(tmp_dir, f"{base}_decrypted.html")
    out_text = os.path.join(tmp_dir, f"{base}_decrypted.txt")

    file_url = Path(html_path).as_uri()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not debug)
        ctx = browser.new_context(locale="ko-KR", viewport={"width": 1280, "height": 2200})
        page = ctx.new_page()
        page.goto(file_url)

        # 비밀번호 입력 + 제출
        page.wait_for_selector("#password", timeout=5000)
        page.fill("#password", password)

        # 정답이면 뷰어로 navigate, 오답이면 같은 페이지에 오류 문구가 남는다.
        navigated = True
        try:
            with page.expect_navigation(timeout=25000):
                page.click("#confirm")
        except Exception:
            navigated = False

        if not navigated:
            body = ""
            try:
                body = page.evaluate("() => document.body ? (document.body.innerText||'') : ''")
            except Exception:
                pass
            if "비밀번호 입력이 잘못" in body:
                print("오류: 비밀번호가 틀렸습니다.", file=sys.stderr)
                sys.exit(2)
            print("오류: 비번 제출 후 명세서 뷰어로 진입하지 못했습니다.", file=sys.stderr)
            sys.exit(3)

        # 명세서 본문이 채워질 때까지 대기 (실제 금액 출현 기준 폴링)
        stage("rendering")
        text = wait_for_statement(page, debug=debug)
        amounts = len(AMOUNT_RE.findall(text))
        if amounts < MIN_AMOUNTS:
            print(
                f"오류: {RENDER_TIMEOUT_S}초 내 명세서 본문이 채워지지 않았습니다 "
                f"(금액 {amounts}건).",
                file=sys.stderr,
            )
            sys.exit(4)

        # 페이지네이션된 나머지 거래까지 모두 펼친 뒤 최종 텍스트 재수집
        expand_pagination(page, debug=debug)
        page.wait_for_timeout(1500)
        text = collect_text(page)
        amounts = len(AMOUNT_RE.findall(text))

        # 총건수와 실제 펼쳐진 행 수 대조 — 불일치면 누락 경고 (실패 처리는 안 함)
        m = re.search(r"총\s*([0-9]+)\s*건", text)
        if m:
            declared = int(m.group(1))
            shown = _row_count(page)
            if shown and shown < declared:
                print(
                    f"경고: 명세서 총 {declared}건인데 {shown}건만 펼쳐짐 — 일부 누락 가능",
                    file=sys.stderr,
                )

        # 결과 저장 — 분석은 PDF(vision)를 쓰므로 PDF가 핵심, txt/html은 보조
        stage("pdf")
        with open(out_text, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            with open(out_html, "w", encoding="utf-8") as f:
                f.write(page.content())
        except Exception:
            pass
        try:
            page.pdf(path=out_pdf, format="A4", print_background=True)
        except Exception as e:
            print(f"PDF 저장 실패(헤드풀 모드에서는 비활성): {e}", file=sys.stderr)

        print(f"✓ 텍스트:  {out_text}  ({len(text)}자, 금액 {amounts}건)")
        print(f"✓ HTML:    {out_html}")
        if os.path.exists(out_pdf):
            print(f"✓ PDF:     {out_pdf}")

        if debug:
            input("디버그 모드: 브라우저 확인 후 엔터를 눌러 종료...")
        browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("html_path")
    parser.add_argument("password")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    decrypt(args.html_path, args.password, args.debug)


if __name__ == "__main__":
    main()
