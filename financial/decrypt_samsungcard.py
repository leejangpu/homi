#!/usr/bin/env python3
"""
삼성카드 VestMail 보안 HTML 첨부를 Playwright로 복호화합니다.

사용법:
    python decrypt_samsungcard.py tmp/samsungcard_20260513.html 890902
    python decrypt_samsungcard.py tmp/samsungcard_20260513.html 890902 --debug

동작 원리 (타이밍 추측이 아니라 페이지 자체의 신호를 따른다):
- VestMail은 비번 제출 시 워커로 복호화하며 `#progressdlg` 스피너를 띄운다.
- 복호화가 끝나면 페이지 스크립트의 `hubmail_onend(isSuccess)`가 호출되어
  `#progressdlg`를 제거하고, 성공이면 `#print` 버튼을 visible로 만든다.
- 복호화된 명세서 본문은 `<iframe id="cipher">`의 contentDocument에 써진다.
따라서 "복호화 완료"는 시간이 아니라 위 DOM 상태 전이로 정확히 판정한다.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# 복호화 완료/실패를 판정하는 JS. 아직 진행 중이면 '' (falsy)를 돌려 계속 대기,
# 끝나면 'done'/'error'를 돌려 wait_for_function이 resolve 되게 한다.
COMPLETION_JS = """
() => {
  const bodyText = document.body ? (document.body.innerText || '') : '';
  if (bodyText.indexOf('비밀번호 입력이 잘못') !== -1) return 'error';

  // 복호화된 본문은 #cipher iframe 안에 써진다
  let cipherLen = 0;
  const ifr = document.getElementById('cipher');
  if (ifr) {
    try {
      const doc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
      if (doc && doc.body) cipherLen = (doc.body.innerText || '').length;
    } catch (e) {}
  }

  // hubmail_onend(true)가 #print를 visible로 만든다 = 복호화 성공 신호
  const printBtn = document.getElementById('print');
  const printVisible = printBtn && getComputedStyle(printBtn).visibility === 'visible';

  if (printVisible || cipherLen > 200) return 'done';
  return '';
}
"""


def extract_cipher_content(page):
    """#cipher iframe(=복호화된 명세서)의 텍스트/HTML을 추출. 없으면 (None, None)."""
    cipher_el = page.query_selector("#cipher")
    if not cipher_el:
        return None, None
    frame = cipher_el.content_frame()
    if not frame:
        return None, None
    try:
        text = frame.evaluate("() => document.body ? (document.body.innerText || '') : ''")
        html = frame.content()
        return text, html
    except Exception:
        return None, None


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

        # 복호화 완료를 페이지 신호로 대기 (타이밍 추측 없음).
        # 성공('done')/비번오류('error')가 나올 때까지 최대 60초.
        try:
            handle = page.wait_for_function(COMPLETION_JS, timeout=60000, polling=300)
            status = handle.json_value()
        except Exception:
            status = "timeout"

        if debug:
            print(f"[debug] 복호화 상태: {status}", file=sys.stderr)

        if status == "error":
            print("오류: 비밀번호가 틀렸습니다.", file=sys.stderr)
            sys.exit(2)
        if status == "timeout":
            print("오류: 복호화 완료 신호를 받지 못했습니다 (타임아웃).", file=sys.stderr)
            sys.exit(3)

        # 복호화된 본문 추출 — #cipher iframe 우선, 없으면 전체 프레임 스캔
        text, inner_html = extract_cipher_content(page)
        if not text or len(text) < 50:
            frames_text = []
            for frame in page.frames:
                try:
                    txt = frame.evaluate("() => document.body && document.body.innerText || ''")
                    if txt and len(txt) > 50:
                        frames_text.append(txt)
                except Exception:
                    pass
            if frames_text:
                text = "\n\n----- frame separator -----\n\n".join(frames_text)

        if not text or len(text) < 50:
            print("오류: 복호화는 완료됐으나 본문 추출 실패 (빈 명세서).", file=sys.stderr)
            sys.exit(4)

        # 결과 저장
        with open(out_text, "w", encoding="utf-8") as f:
            f.write(text)
        with open(out_html, "w", encoding="utf-8") as f:
            f.write(inner_html if inner_html else page.content())
        try:
            page.pdf(path=out_pdf, format="A4", print_background=True)
        except Exception as e:
            print(f"PDF 저장 실패(헤드풀 모드에서는 비활성): {e}", file=sys.stderr)

        print(f"✓ 텍스트:  {out_text}  ({len(text)}자)")
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
