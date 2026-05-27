#!/usr/bin/env python3
"""
삼성카드 VestMail 보안 HTML 첨부를 Playwright로 복호화합니다.

사용법:
    python decrypt_samsungcard.py tmp/samsungcard_20260513.html 890902
    python decrypt_samsungcard.py tmp/samsungcard_20260513.html 890902 --debug
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


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
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(file_url)

        # 비밀번호 입력 + 제출
        page.wait_for_selector("#password", timeout=5000)
        page.fill("#password", password)
        page.click("#confirm")

        # 복호화 대기 — VestMail은 페이지 자체를 새 콘텐츠로 교체
        page.wait_for_timeout(3000)

        # 실패 메시지 검사
        body_text = page.evaluate("() => document.body.innerText || ''")
        if "비밀번호 입력이 잘못" in body_text:
            print("오류: 비밀번호가 틀렸습니다.", file=sys.stderr)
            sys.exit(2)

        # iframe 안에 명세서가 렌더링되는 경우를 대비
        frames_text = []
        for frame in page.frames:
            try:
                txt = frame.evaluate("() => document.body && document.body.innerText || ''")
                if txt and len(txt) > 50:
                    frames_text.append(txt)
            except Exception:
                pass

        full_text = "\n\n----- frame separator -----\n\n".join(frames_text) if frames_text else body_text

        # 결과 저장
        with open(out_text, "w", encoding="utf-8") as f:
            f.write(full_text)
        with open(out_html, "w", encoding="utf-8") as f:
            f.write(page.content())
        try:
            page.pdf(path=out_pdf, format="A4", print_background=True)
        except Exception as e:
            print(f"PDF 저장 실패(헤드풀 모드에서는 비활성): {e}", file=sys.stderr)

        print(f"✓ 텍스트:  {out_text}  ({len(full_text)}자)")
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
