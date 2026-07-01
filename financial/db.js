// Homi 가계부 DB (better-sqlite3, 임베디드 단일 파일)
// - authoritative 런타임 저장소. git에는 사람이 읽는 export(CSV/JSON)만 올라감.
// - 별도 DB 프로세스 없음 → 로컬 Express 서버 단일 프로세스에 그대로 붙음.
// 스키마 상세/설계 근거: financial/docs/db-migration-plan.md

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.HOMI_DB_PATH || path.join(DATA_DIR, 'homi.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
// 동시성/안정성 프라그마
db.pragma('journal_mode = WAL');   // 읽기-쓰기 동시성 향상
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');  // 잠금 경합 시 대기(ms)

const SCHEMA_VERSION = 1;

function initSchema() {
  db.exec(`
    -- 메타(스키마 버전, 동기화 상태 등 키-값)
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    -- 가계부 시트: 원본 그리드를 셀 단위로 저장(충실한 round-trip + 셀 단위 낙관적 잠금).
    -- 섹션/합계 의미는 저장하지 않고 읽을 때 서버가 계산(splitSections/calcAllTotals 포팅).
    -- r/c 는 CSV 2D 배열의 행/열 인덱스(0-base). 빈 셀은 미저장(없으면 빈값).
    CREATE TABLE IF NOT EXISTS budget_cell (
      year      INTEGER NOT NULL,          -- 2025, 2026 ...
      r         INTEGER NOT NULL,          -- 행 인덱스(0-base)
      c         INTEGER NOT NULL,          -- 열 인덱스(0-base)
      raw       TEXT,                       -- 원본 문자열(수식 "=a+b", "₩1,000" 등 그대로 보존)
      version   INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      updated_by TEXT,
      PRIMARY KEY(year, r, c)
    );

    -- 시트 메타(원본 그리드 크기 보존 — 재구성 시 정확한 행/열 수 복원용)
    CREATE TABLE IF NOT EXISTS budget_sheet (
      year      INTEGER PRIMARY KEY,
      n_rows    INTEGER NOT NULL,
      n_cols    INTEGER NOT NULL,
      updated_at TEXT
    );

    -- VR 계산기 트래커(티커별). computed(파생값)은 저장하지 않음.
    CREATE TABLE IF NOT EXISTS vr_tracker (
      ticker    TEXT PRIMARY KEY,
      data      TEXT NOT NULL,             -- 트래커 필드 JSON
      version   INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      updated_by TEXT
    );

    -- VR 종료 사이클 히스토리(append)
    CREATE TABLE IF NOT EXISTS vr_history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker    TEXT NOT NULL,
      ended_at  TEXT NOT NULL,
      data      TEXT NOT NULL,             -- 종료 스냅샷 JSON
      version   INTEGER NOT NULL DEFAULT 1
    );

    -- 영수증 분석 지출내역(연/월 단위 blob). 편집 단위가 월 전체(영수증 임포트)라 월별 blob로 저장.
    -- data = { cards:[...], items:[{날짜,가맹점,카드,금액,카테고리}, ...] }
    CREATE TABLE IF NOT EXISTS expense_month (
      year      INTEGER NOT NULL,
      month     INTEGER NOT NULL,          -- 1..12
      data      TEXT NOT NULL,
      version   INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      updated_by TEXT,
      PRIMARY KEY(year, month)
    );

    -- 월간 AI 요약(B등급, CI 생성 → import). 읽기 모델.
    CREATE TABLE IF NOT EXISTS ai_summary (
      year      INTEGER NOT NULL,
      month     INTEGER NOT NULL,          -- 1..12
      data      TEXT NOT NULL,             -- summary.json의 월 객체 JSON
      updated_at TEXT,
      PRIMARY KEY(year, month)
    );

    -- 외부 서브시스템 읽기전용 미러(E등급, 소유권 이전 X)
    CREATE TABLE IF NOT EXISTS ext_mirror (
      source    TEXT NOT NULL,             -- lotto | infinite-buy
      key       TEXT NOT NULL,             -- history | config | state:TQQQ | history:xxx.json ...
      data      TEXT NOT NULL,             -- 원본 JSON 문자열
      synced_at TEXT,
      PRIMARY KEY(source, key)
    );
  `);

  const cur = getMeta('schema_version');
  if (cur == null) setMeta('schema_version', String(SCHEMA_VERSION));
}

function getMeta(k) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : null;
}
function setMeta(k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

initSchema();

module.exports = { db, getMeta, setMeta, DB_PATH, SCHEMA_VERSION };
