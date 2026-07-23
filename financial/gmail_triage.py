#!/usr/bin/env python3
"""Gmail 받은편지함 안읽음 정리 (데일리 루틴).

흐름:
  1. 안읽음 메일(is:unread in:inbox) 수집 (발신/제목/스니펫)
  2. 간단 기계 필터링은 최소화 — Claude CLI(sonnet)로 중요도 분류
  3. 기계성 메일 → 보관처리(UNREAD·INBOX 라벨 제거: 읽음 + 받은편지함에서 치움)
  4. 중요 메일 → 받은편지함에 안읽음으로 남기고 Alram🔔 텔레그램으로 요약 전송

결과적으로 받은편지함에는 '내가 읽어야 할 메일'만 안읽음으로 남는다.

삼성카드 루틴(sync_samsungcard.py)과 토큰을 분리한다:
  - credentials.json 은 공유(같은 OAuth 클라이언트)
  - token_modify.json 은 이 스크립트 전용 (gmail.modify 스코프)

최초 1회 브라우저 동의:  python gmail_triage.py --auth
평소 실행:               python gmail_triage.py          (읽음처리 + 텔레그램 전송)
안전 점검(변경 없음):     python gmail_triage.py --dry-run
"""
import os
import sys
import json
import re
import subprocess
from datetime import datetime

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
LOG_DIR = os.path.join(SCRIPT_DIR, "logs")

# gmail.modify = 읽기 + 라벨 수정(읽음처리). readonly 상위집합.
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
CREDENTIALS_PATH = os.path.join(SCRIPT_DIR, "credentials.json")
TOKEN_PATH = os.path.join(SCRIPT_DIR, "token_modify.json")

# 텔레그램 자격증명 소스 (Alram🔔 봇). infinite-buy/.env 재사용.
ENV_CANDIDATES = [
    os.path.join(REPO_DIR, "infinite-buy", ".env"),
    os.path.join(REPO_DIR, "signal-alert", ".env"),
]

CLAUDE_MODEL = "claude-sonnet-4-6"
BATCH_SIZE = 40      # Claude 1회 분류에 넘길 메일 수
LOOKBACK_DAYS = 2    # 데일리 실행은 최근 N일 안읽음만 처리(밀린 backlog 무시)


def log(msg: str):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


# ---------------------------------------------------------------- 인증
def do_auth():
    """최초 1회: 브라우저 동의로 token_modify.json 발급."""
    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
    creds = flow.run_local_server(port=0)
    with open(TOKEN_PATH, "w") as f:
        f.write(creds.to_json())
    log(f"인증 완료 → {TOKEN_PATH} (스코프: gmail.modify)")


def get_service():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(TOKEN_PATH, "w") as f:
                f.write(creds.to_json())
        else:
            log("인증 필요: `python gmail_triage.py --auth` 를 먼저 실행하세요 (브라우저 동의).")
            return None
    return build("gmail", "v1", credentials=creds)


# ---------------------------------------------------------------- 메일 수집
def fetch_unread(service, cap=100, lookback_days=LOOKBACK_DAYS):
    """안읽음 받은편지함 메일을 최신순으로 수집.

    기본은 최근 lookback_days 이내만 (데일리 루틴용, 밀린 backlog 무시).
    lookback_days=None 이면 전체(=1회성 backlog 정리용).
    """
    q = "is:unread in:inbox"
    if lookback_days is not None:
        q += f" newer_than:{lookback_days}d"
    ids = []
    req = service.users().messages().list(userId="me", q=q, maxResults=100)
    while req is not None and len(ids) < cap:
        resp = req.execute()
        ids.extend(m["id"] for m in resp.get("messages", []))
        req = service.users().messages().list_next(req, resp)
    ids = ids[:cap]

    mails = []
    for mid in ids:
        m = service.users().messages().get(
            userId="me", id=mid, format="metadata",
            metadataHeaders=["From", "Subject"],
        ).execute()
        headers = {h["name"].lower(): h["value"]
                   for h in m.get("payload", {}).get("headers", [])}
        mails.append({
            "id": mid,
            "from": headers.get("from", ""),
            "subject": headers.get("subject", ""),
            "snippet": (m.get("snippet", "") or "")[:200],
        })
    return mails


# ---------------------------------------------------------------- AI 분류
CLASSIFY_INSTRUCTIONS = """너는 개인 Gmail 받은편지함의 안읽음 메일을 중요도로 분류한다. 사용자(한국)의 관점에서 '그냥 읽음처리하고 넘겨도 되는 기계적 메일(mechanical)'과 '사용자가 알아야 할 중요 메일(important)'을 구분해라.

mechanical = 읽음처리 대상: 본인 활동으로 보이는 로그인/보안 알림, 프로모션/마케팅, 뉴스레터, 개인정보 이용내역 정기통지, 약관/정책 개정 정기안내, 결제영수증/카드명세서, 오픈뱅킹 정기 제공내역, 스토리지 안내 등.

important = 텔레그램 요약 대상: 사용자가 조치해야 하거나 손해·리스크·수익에 영향을 주는 것. 예: 본인 프로젝트/앱의 빌드 실패·서비스 제한, 광고 수익 제한, 실제 비밀번호 유출 경고, 프로젝트(homi/무한매수법)와 직접 관련된 API 약관 변경, 명백히 본인이 아닌 의심 로그인 등. 애매하면 important.

컨텍스트: 사용자는 'homi' 개인 자동화 프로젝트를 운영. 토스증권·한국투자증권 오픈 API를 무한매수법 자동매매에 사용. GitHub leejangpu/homi 저장소 보유. AdMob/Google Play 개발자 계정으로 앱 운영.

아래 메일 목록을 분류해서 JSON만 출력해라(코드펜스·설명 없이):
{"important":[{"id":"...","title":"짧은 한글 제목","summary":"한 줄 요약(왜 신경써야 하는지 포함)"}],"mechanical":["id","id"]}
모든 id가 important 또는 mechanical 중 정확히 한 곳에만 들어가야 한다.

메일 목록:
"""


def classify_batch(mails):
    lines = []
    for i, m in enumerate(mails, 1):
        lines.append(f'{i}. id={m["id"]} | {m["from"]} | {m["subject"]} | {m["snippet"]}')
    prompt = CLASSIFY_INSTRUCTIONS + "\n".join(lines)

    # 순수 텍스트 분류 — 도구 사용 완전 차단(--allowedTools "").
    # 권한 스킵 없이 무인 실행돼도 파일/명령에 손대지 않는다.
    proc = subprocess.run(
        ["claude", "-p", "--model", CLAUDE_MODEL, "--allowedTools", ""],
        input=prompt, capture_output=True, text=True,
    )
    out = proc.stdout.strip()
    if proc.returncode != 0:
        log(f"claude 호출 실패(rc={proc.returncode}): {proc.stderr.strip()[:300]}")
        return None
    # JSON 추출
    match = re.search(r"\{.*\}", out, re.DOTALL)
    if not match:
        log(f"claude 응답에서 JSON 못 찾음: {out[:200]}")
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as e:
        log(f"JSON 파싱 실패: {e} / {out[:200]}")
        return None


def classify_all(mails):
    valid = {m["id"] for m in mails}
    important, mechanical = [], []
    for start in range(0, len(mails), BATCH_SIZE):
        batch = mails[start:start + BATCH_SIZE]
        res = classify_batch(batch)
        if res is None:
            log(f"배치 {start//BATCH_SIZE + 1} 분류 실패 — 해당 배치는 안전하게 건너뜀(읽음처리 안 함)")
            continue
        for item in res.get("important", []):
            if item.get("id") in valid:
                important.append(item)
        for mid in res.get("mechanical", []):
            if mid in valid:
                mechanical.append(mid)
    # important 로 분류된 건 mechanical 에서 제외(읽음 유지)
    imp_ids = {it["id"] for it in important}
    mechanical = [mid for mid in mechanical if mid not in imp_ids]
    return important, mechanical


# ---------------------------------------------------------------- 실행 액션
def archive_mails(service, ids):
    """기계성 메일을 읽음처리 + 보관(아카이브): UNREAD·INBOX 라벨 제거.
    받은편지함에서 사라지고(보관함/전체메일에는 남음) 읽음 상태가 된다."""
    if not ids:
        return
    for start in range(0, len(ids), 1000):
        chunk = ids[start:start + 1000]
        service.users().messages().batchModify(
            userId="me",
            body={"ids": chunk, "removeLabelIds": ["UNREAD", "INBOX"]},
        ).execute()


def load_telegram_creds():
    for path in ENV_CANDIDATES:
        if not os.path.exists(path):
            continue
        token = chat = None
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("TELEGRAM_CHAT_ID="):
                    chat = line.split("=", 1)[1].strip().strip('"').strip("'")
        if token and chat:
            return token, chat
    return None, None


def _chunk_by_lines(text, limit=3800):
    """텔레그램 4096자 제한 대응: 줄 경계로 limit 이하 청크로 분할."""
    chunks, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > limit and cur:
            chunks.append(cur)
            cur = ""
        cur += (line + "\n")
    if cur.strip():
        chunks.append(cur)
    return chunks


def send_telegram(text):
    import urllib.request
    import urllib.parse
    token, chat = load_telegram_creds()
    if not token:
        log("텔레그램 자격증명 못 찾음 — 전송 생략")
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    chunks = _chunk_by_lines(text)
    all_ok = True
    for i, chunk in enumerate(chunks):
        prefix = f"({i+1}/{len(chunks)})\n" if len(chunks) > 1 else ""
        data = urllib.parse.urlencode({"chat_id": chat, "text": prefix + chunk}).encode()
        try:
            with urllib.request.urlopen(url, data=data, timeout=15) as resp:
                ok = json.load(resp).get("ok", False)
            all_ok = all_ok and ok
        except Exception as e:
            log(f"텔레그램 전송 실패(청크 {i+1}/{len(chunks)}): {e}")
            all_ok = False
    return all_ok


def build_message(important):
    today = datetime.now().strftime("%m/%d")
    lines = [f"📬 Gmail 안읽음 정리 ({today})", ""]
    if not important:
        lines.append("확인 필요한 중요 메일 없음. 기계성 메일은 보관처리 완료.")
    else:
        lines.append(f"[확인 필요 · {len(important)}건] (받은편지함에 안읽음으로 남겨둠)")
        for it in important:
            lines.append(f"• {it.get('title','(제목없음)')} — {it.get('summary','')}")
    return "\n".join(lines)


# ---------------------------------------------------------------- main
def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    if "--auth" in sys.argv:
        do_auth()
        return
    dry = "--dry-run" in sys.argv
    # --all: 밀린 backlog 전체(1회성 정리). 기본은 최근 LOOKBACK_DAYS일만.
    lookback = None if "--all" in sys.argv else LOOKBACK_DAYS

    service = get_service()
    if service is None:
        sys.exit(1)

    scope = "전체(backlog)" if lookback is None else f"최근 {lookback}일"
    # --all(backlog)은 상한을 크게, 데일리는 100 유지
    cap = 2000 if lookback is None else 100
    mails = fetch_unread(service, cap=cap, lookback_days=lookback)
    log(f"안읽음 수집({scope}): {len(mails)}개")
    if not mails:
        log("처리할 안읽음 없음.")
        return

    important, mechanical = classify_all(mails)
    log(f"분류 결과 → 중요 {len(important)}건 / 기계성 {len(mechanical)}건")

    if dry:
        log("[DRY-RUN] 보관처리/전송 생략.")
        log("중요: " + json.dumps([it.get("title") for it in important], ensure_ascii=False))
        return

    archive_mails(service, mechanical)
    log(f"보관처리(읽음+아카이브) 완료: {len(mechanical)}개")

    msg = build_message(important)
    if send_telegram(msg):
        log("텔레그램 전송 완료.")
    else:
        log("텔레그램 전송 실패/생략.")


if __name__ == "__main__":
    main()
