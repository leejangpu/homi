# 데일리 루틴 (Daily Routine)

매일 정해진 시각에 자동으로 도는 **개인 자동화 작업 모음**. 이메일 확인 → 지출 반영처럼 "매일 알아서 처리되는 잡일"을 여기에 모은다. 앞으로 추가되는 데일리 루틴 작업은 **원칙적으로 이 디렉토리에 둔다**.

> 트레이딩(무한매수법)·로또·시장 신호 알림처럼 독립 서브시스템으로 다루는 스케줄은 여기가 아니라 각 디렉토리 + 루트 `CLAUDE.md`의 "스케줄러 매핑"에 있다. 데일리 루틴은 그중 **가볍고 개인 잡무성**인 매일 반복 작업을 묶는 상위 개념이다.

## 현재 루틴

| 루틴 | 시각(KST) | 코드 진입점 | plist | 상태 |
|---|---|---|---|---|
| 카드 명세서 지출 반영 (현재 삼성카드) | 매일 09:00 | `financial/sync_samsungcard.py` | `com.homi.samsungcard-sync.plist` | ✅ 운영중 |

### 카드 명세서 지출 반영
- Gmail(`gmail.readonly`)에서 카드사 이용대금 메일 검색(현재 `from:bill@samsungcard.com`) → 새 명세서만 선별(`financial/processed_statements.json`) → 첨부 HTML 복호화(Keychain 비밀번호)→PDF → `analyze-receipt.sh`로 Claude 분석 → `expense_detail.json` + 가계부 CSV(→ gitsync로 DB) 반영.
- **코드가 `financial/`에 있는 이유**: Gmail OAuth(`credentials.json`/`token.json`)·복호화(`decrypt_samsungcard.py`)·분석(`analyze-receipt.sh`)·`.venv`·가계부 반영이 전부 `financial/`에 강결합. 이관하면 plist·import·venv 경로를 모두 바꿔야 해 현 위치 유지. **분류상으로만 데일리 루틴**이다.
- 상세 주의(라이브 뷰어 렌더 폴링 + "더보기" 페이지네이션): 메모리 `project_samsungcard_decrypt`.

## 새 루틴 추가법

1. 스크립트를 `daily-routine/<루틴이름>/` 에 둔다(가계부처럼 기존 서브시스템에 강결합이면 그쪽에 두고 여기 표에서만 분류해도 됨).
2. macOS launchd plist `~/Library/LaunchAgents/com.homi.<루틴이름>.plist` 등록(또는 GH Actions 워크플로).
3. **위 "현재 루틴" 표**와 루트 `CLAUDE.md`의 "데일리 루틴" 절 표에 한 줄 추가.
4. 알림이 필요하면 Alram🔔 봇(`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) 재사용.
