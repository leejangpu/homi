#!/usr/bin/env python3
"""
삼성카드 이용대금 명세서 메일에서 첨부 HTML을 다운로드합니다.

처음 실행 시 브라우저가 열려 Google 계정 동의를 요청합니다.
이후 financial/token.json 에 자격 증명이 저장되어 무인 실행 가능합니다.

사용법:
    python fetch_samsungcard.py                  # 최근 60일 내 가장 최근 명세서
    python fetch_samsungcard.py --days 90        # 검색 기간 조정
    python fetch_samsungcard.py --all            # 검색된 모든 명세서 다운로드
"""
from __future__ import annotations

import argparse
import base64
import os
import re
import sys
from datetime import datetime

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_PATH = os.path.join(SCRIPT_DIR, "credentials.json")
TOKEN_PATH = os.path.join(SCRIPT_DIR, "token.json")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "tmp")

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def get_gmail_service():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_PATH):
                print(f"오류: {CREDENTIALS_PATH} 가 없습니다.", file=sys.stderr)
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())
        os.chmod(TOKEN_PATH, 0o600)
    return build("gmail", "v1", credentials=creds)


def search_samsungcard(service, days: int):
    query = f"from:bill@samsungcard.com 이용대금 newer_than:{days}d"
    result = service.users().messages().list(userId="me", q=query, maxResults=20).execute()
    return result.get("messages", [])


def get_message_date(headers: list) -> str:
    for h in headers:
        if h["name"].lower() == "date":
            try:
                # 예: "Wed, 6 May 2026 02:07:37 +0000" → "20260506"
                dt = datetime.strptime(h["value"][:25].strip(), "%a, %d %b %Y %H:%M:%S")
                return dt.strftime("%Y%m%d")
            except ValueError:
                pass
    return datetime.now().strftime("%Y%m%d")


def get_subject(headers: list) -> str:
    for h in headers:
        if h["name"].lower() == "subject":
            return h["value"]
    return ""


def find_billing_date(subject: str) -> str | None:
    # "2026년 05월 13일" → "20260513"
    m = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", subject)
    if m:
        return f"{m.group(1)}{m.group(2).zfill(2)}{m.group(3).zfill(2)}"
    return None


def download_attachment(service, message_id: str) -> str | None:
    msg = service.users().messages().get(userId="me", id=message_id, format="full").execute()
    headers = msg["payload"].get("headers", [])
    received_date = get_message_date(headers)
    subject = get_subject(headers)
    billing_date = find_billing_date(subject) or received_date

    parts = msg["payload"].get("parts", [])
    for part in parts:
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

        os.makedirs(OUTPUT_DIR, exist_ok=True)
        ext = ".html" if filename.endswith(".html") else os.path.splitext(filename)[1] or ".bin"
        out_path = os.path.join(OUTPUT_DIR, f"samsungcard_{billing_date}{ext}")
        with open(out_path, "wb") as f:
            f.write(data)
        return out_path
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    service = get_gmail_service()
    messages = search_samsungcard(service, args.days)
    if not messages:
        print(f"최근 {args.days}일 내 삼성카드 명세서가 없습니다.")
        return

    targets = messages if args.all else messages[:1]
    print(f"검색된 메일: {len(messages)}개, 다운로드 대상: {len(targets)}개")
    for m in targets:
        path = download_attachment(service, m["id"])
        if path:
            print(f"  ✓ 저장: {path}")
        else:
            print(f"  - 첨부 없음: {m['id']}")


if __name__ == "__main__":
    main()
