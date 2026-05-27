#!/usr/bin/env python3
"""
삼성카드 이용대금 명세서 자동 동기화 스크립트.

흐름:
1. Gmail에서 최근 삼성카드 명세서 메일 검색
2. processed_statements.json 과 비교해 새 메일만 골라냄
3. 첨부 HTML 다운로드
4. Playwright + keychain 비밀번호로 복호화 → PDF 생성
5. analyze-receipt.sh 호출 → Claude 분석 → expense_detail.json + CSV 반영
6. processed_statements.json 갱신
7. 텔레그램 알림 (선택)

매일 1회 launchd 로 실행되도록 설계.
새 명세서가 없으면 조용히 종료.
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from playwright.sync_api import sync_playwright


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TMP_DIR = os.path.join(SCRIPT_DIR, "tmp")
LOG_DIR = os.path.join(SCRIPT_DIR, "logs")
PROCESSED_PATH = os.path.join(SCRIPT_DIR, "processed_statements.json")
KEYCHAIN_SERVICE = "homi.financial.samsungcard.bill"
KEYCHAIN_ACCOUNT = "samsungcard-bill"

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# 계정 정의: (라벨, credentials_path, token_path)
ACCOUNTS = [
    {
        "label": "self",
        "credentials": os.path.join(SCRIPT_DIR, "credentials.json"),
        "token": os.path.join(SCRIPT_DIR, "token.json"),
    },
    # 와이프 계정 추가 시:
    # {"label": "spouse", "credentials": ".../credentials.json", "token": "token_spouse.json"},
]


def log(msg: str):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


def load_processed() -> dict:
    if os.path.exists(PROCESSED_PATH):
        with open(PROCESSED_PATH) as f:
            return json.load(f)
    return {}


def save_processed(data: dict):
    with open(PROCESSED_PATH, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_password_from_keychain() -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        log(f"keychain 조회 실패: {result.stderr.strip()}")
        sys.exit(1)
    return result.stdout.strip()


def get_gmail_service(account: dict):
    creds = None
    if os.path.exists(account["token"]):
        creds = Credentials.from_authorized_user_file(account["token"], SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(account["token"], "w") as f:
                f.write(creds.to_json())
        else:
            log(f"{account['label']} 계정 인증 필요: 수동으로 fetch_samsungcard.py 실행 후 동의 클릭")
            return None
    return build("gmail", "v1", credentials=creds)


def search_messages(service, days: int = 30) -> list:
    query = f"from:bill@samsungcard.com 이용대금 newer_than:{days}d"
    return service.users().messages().list(userId="me", q=query, maxResults=10).execute().get("messages", [])


def parse_billing_date(subject: str) -> str:
    m = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", subject)
    if m:
        return f"{m.group(1)}{m.group(2).zfill(2)}{m.group(3).zfill(2)}"
    return datetime.now().strftime("%Y%m%d")


def download_attachment(service, message_id: str, label: str) -> tuple[str, str] | None:
    msg = service.users().messages().get(userId="me", id=message_id, format="full").execute()
    headers = msg["payload"].get("headers", [])
    subject = next((h["value"] for h in headers if h["name"].lower() == "subject"), "")
    billing_date = parse_billing_date(subject)

    for part in msg["payload"].get("parts", []):
        filename = part.get("filename", "")
        if not filename:
            continue
        body = part.get("body", {})
        att_id = body.get("attachmentId")
        if not att_id:
            continue
        att = service.users().messages().attachments().get(
            userId="me", messageId=message_id, id=att_id
        ).execute()
        data = base64.urlsafe_b64decode(att["data"])
        os.makedirs(TMP_DIR, exist_ok=True)
        out_path = os.path.join(TMP_DIR, f"samsungcard_{label}_{billing_date}.html")
        with open(out_path, "wb") as f:
            f.write(data)
        return out_path, billing_date
    return None


def decrypt_html(html_path: str, password: str) -> str | None:
    base = os.path.splitext(html_path)[0]
    out_pdf = f"{base}_decrypted.pdf"
    file_url = Path(html_path).as_uri()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(file_url)
        page.wait_for_selector("#password", timeout=5000)
        page.fill("#password", password)
        page.click("#confirm")
        page.wait_for_timeout(3000)

        body_text = page.evaluate("() => document.body.innerText || ''")
        if "비밀번호 입력이 잘못" in body_text:
            log("복호화 실패: 비밀번호가 틀렸습니다.")
            browser.close()
            return None

        page.pdf(path=out_pdf, format="A4", print_background=True)
        browser.close()
    return out_pdf


def analyze_and_update(pdf_path: str, billing_date: str):
    year = billing_date[:4]
    month = billing_date[4:6]
    filename = os.path.basename(pdf_path)
    cmd = ["bash", os.path.join(SCRIPT_DIR, "analyze-receipt.sh"), year, month, filename]
    log(f"analyze-receipt.sh 호출: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR, capture_output=True, text=True)
    log(result.stdout[-2000:])
    if result.returncode != 0:
        log(f"analyze-receipt 실패: {result.stderr[-1000:]}")
        return False
    return True


def process_message(service, msg_id: str, label: str, password: str) -> dict | None:
    log(f"[{label}] 메일 처리 시작: {msg_id}")
    result = download_attachment(service, msg_id, label)
    if not result:
        log(f"[{label}] 첨부 없음")
        return None
    html_path, billing_date = result
    log(f"[{label}] HTML 다운로드: {html_path} (청구일 {billing_date})")

    pdf_path = decrypt_html(html_path, password)
    if not pdf_path:
        return None
    log(f"[{label}] 복호화 완료: {pdf_path}")

    ok = analyze_and_update(pdf_path, billing_date)
    return {
        "billing_date": billing_date,
        "html": html_path,
        "pdf": pdf_path,
        "analyzed": ok,
        "processed_at": datetime.now().isoformat(timespec="seconds"),
        "account": label,
    }


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    processed = load_processed()
    password = get_password_from_keychain()

    new_count = 0
    for account in ACCOUNTS:
        service = get_gmail_service(account)
        if service is None:
            continue
        try:
            messages = search_messages(service, days=30)
        except Exception as e:
            log(f"[{account['label']}] 메일 검색 실패: {e}")
            continue
        log(f"[{account['label']}] 검색된 메일: {len(messages)}개")
        for m in messages:
            if m["id"] in processed:
                continue
            entry = process_message(service, m["id"], account["label"], password)
            if entry:
                processed[m["id"]] = entry
                save_processed(processed)
                new_count += 1
            time.sleep(1)

    log(f"완료: 새로 처리된 명세서 {new_count}개")


if __name__ == "__main__":
    main()
