#!/usr/bin/env node
// 1회성(멱등) 마이그레이션: 기존 파일 데이터 → SQLite DB.
// 원본 파일은 삭제하지 않는다(이후 export 대상이 됨).
// 실행: node scripts/migrate-to-db.js   (검증만: --verify-only)
// 설계: financial/docs/db-migration-plan.md

const fs = require('fs');
const path = require('path');
const { db, setMeta } = require('../db');
const { parseCSV, toCSVFile } = require('../sheet');

const ROOT = path.join(__dirname, '..');            // financial/
const REPO = path.join(ROOT, '..');                 // repo root
const now = () => new Date().toISOString();
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

const YEARS = ['2025', '2026'];
let problems = 0;

// ---------- 1. 가계부 시트(그리드) ----------
function migrateBudget() {
  const insCell = db.prepare(
    `INSERT INTO budget_cell (year, r, c, raw, version, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(year, r, c) DO UPDATE SET raw=excluded.raw, updated_at=excluded.updated_at`
  );
  const insSheet = db.prepare(
    `INSERT INTO budget_sheet (year, n_rows, n_cols, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET n_rows=excluded.n_rows, n_cols=excluded.n_cols, updated_at=excluded.updated_at`
  );
  for (const y of YEARS) {
    const p = path.join(ROOT, `${y}.csv`);
    if (!exists(p)) { console.log(`  [budget] ${y}.csv 없음 — 건너뜀`); continue; }
    const raw = fs.readFileSync(p, 'utf8');
    const grid = parseCSV(raw);
    const nRows = grid.length;
    const nCols = grid.length ? grid[0].length : 0;
    db.prepare('DELETE FROM budget_cell WHERE year = ?').run(Number(y));
    const tx = db.transaction(() => {
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          const v = grid[r][c];
          if (v !== '' && v != null) insCell.run(Number(y), r, c, String(v), now());
        }
      }
      insSheet.run(Number(y), nRows, nCols, now());
    });
    tx();
    console.log(`  [budget] ${y}: ${nRows}행 × ${nCols}열 적재`);
  }
}

// DB → 그리드 재구성 (읽기/round-trip 공용)
function rebuildGrid(year) {
  const meta = db.prepare('SELECT n_rows, n_cols FROM budget_sheet WHERE year = ?').get(Number(year));
  if (!meta) return null;
  const grid = Array.from({ length: meta.n_rows }, () => Array(meta.n_cols).fill(''));
  const cells = db.prepare('SELECT r, c, raw FROM budget_cell WHERE year = ?').all(Number(year));
  for (const { r, c, raw } of cells) if (r < meta.n_rows && c < meta.n_cols) grid[r][c] = raw ?? '';
  return grid;
}

// ---------- 2. VR 트래커 ----------
function migrateVrTrackers() {
  const p = path.join(ROOT, 'vr-state.json');
  if (!exists(p)) { console.log('  [vr] vr-state.json 없음'); return; }
  const state = readJSON(p);
  const ins = db.prepare(
    `INSERT INTO vr_tracker (ticker, data, version, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(ticker) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  );
  let n = 0;
  for (const [ticker, obj] of Object.entries(state)) {
    // computed는 파생 캐시지만 그대로 보존(읽기 충실도). 쓰기(P3/P4) 시 서버가 재계산.
    ins.run(ticker, JSON.stringify(obj), now());
    n++;
  }
  console.log(`  [vr] 트래커 ${n}개 적재`);
}

// ---------- 3. VR 히스토리 ----------
function migrateVrHistory() {
  const p = path.join(ROOT, 'vr-history.json');
  if (!exists(p)) { console.log('  [vr] vr-history.json 없음'); return; }
  const arr = readJSON(p);
  db.prepare('DELETE FROM vr_history').run();
  const ins = db.prepare('INSERT INTO vr_history (ticker, ended_at, data, version) VALUES (?, ?, ?, 1)');
  const tx = db.transaction(() => {
    for (const e of arr) ins.run(e.ticker || '', e.endedAt || e.lastUpdated || '', JSON.stringify(e));
  });
  tx();
  console.log(`  [vr] 히스토리 ${arr.length}건 적재`);
}

// ---------- 4. 영수증 지출내역(월별 blob) ----------
function migrateExpense() {
  const p = path.join(ROOT, 'expense_detail.json');
  if (!exists(p)) { console.log('  [expense] expense_detail.json 없음'); return; }
  const data = readJSON(p);
  const ins = db.prepare(
    `INSERT INTO expense_month (year, month, data, version, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(year, month) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  );
  let n = 0;
  for (const [year, months] of Object.entries(data)) {
    for (const [mm, obj] of Object.entries(months)) {
      ins.run(Number(year), Number(mm), JSON.stringify(obj), now());
      n++;
    }
  }
  console.log(`  [expense] ${n}개 월 적재`);
}

// ---------- 5. AI 요약 ----------
function migrateSummary() {
  const p = path.join(ROOT, 'summary.json');
  if (!exists(p)) { console.log('  [summary] summary.json 없음'); return; }
  const data = readJSON(p);
  const ins = db.prepare(
    `INSERT INTO ai_summary (year, month, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  );
  let n = 0;
  for (const [year, months] of Object.entries(data)) {
    for (const [mm, obj] of Object.entries(months)) {
      ins.run(Number(year), Number(mm), JSON.stringify(obj), now());
      n++;
    }
  }
  console.log(`  [summary] ${n}개 월 적재`);
}

// ---------- 6. 외부 서브시스템 읽기전용 미러 ----------
function migrateExtMirror() {
  const ins = db.prepare(
    `INSERT INTO ext_mirror (source, key, data, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(source, key) DO UPDATE SET data=excluded.data, synced_at=excluded.synced_at`
  );
  let n = 0;
  const put = (source, key, p) => {
    if (!exists(p)) return;
    ins.run(source, key, fs.readFileSync(p, 'utf8'), now()); n++;
  };
  // 로또
  put('lotto', 'history', path.join(REPO, 'lotto/history.json'));
  // 무한매수법
  put('infinite-buy', 'config', path.join(REPO, 'infinite-buy/config.json'));
  const stateDir = path.join(REPO, 'infinite-buy/state');
  if (exists(stateDir)) for (const f of fs.readdirSync(stateDir)) {
    if (f === 'token.json' || !f.endsWith('.json')) continue; // 시크릿 제외
    put('infinite-buy', 'state:' + f.replace(/\.json$/, ''), path.join(stateDir, f));
  }
  const histDir = path.join(REPO, 'infinite-buy/history');
  if (exists(histDir)) for (const f of fs.readdirSync(histDir)) {
    if (!f.endsWith('.json')) continue;
    put('infinite-buy', 'history:' + f, path.join(histDir, f));
  }
  console.log(`  [ext] 외부 미러 ${n}개 적재`);
}

// ---------- Round-trip 검증(budget): DB→그리드→CSV == 원본 파일 ----------
function verifyBudget() {
  console.log('\n== Round-trip 검증(budget) ==');
  for (const y of YEARS) {
    const p = path.join(ROOT, `${y}.csv`);
    if (!exists(p)) continue;
    const original = fs.readFileSync(p, 'utf8');
    const grid = rebuildGrid(y);
    if (!grid) { console.log(`  ✗ ${y}: DB에 그리드 없음`); problems++; continue; }
    const rebuilt = toCSVFile(grid);
    // 원본이 이미 app-canonical(BOM + toCSV)이면 정확히 일치해야 함.
    // 혹시 원본이 비정규 형태면 canonical끼리 비교(toCSVFile(parseCSV(original)))로 판정.
    const canonical = toCSVFile(parseCSV(original));
    if (rebuilt === original) {
      console.log(`  ✓ ${y}: 원본과 바이트 동일`);
    } else if (rebuilt === canonical) {
      console.log(`  ✓ ${y}: canonical 형태 일치 (원본은 비정규 — export 시 정규화됨)`);
    } else {
      console.log(`  ✗ ${y}: 불일치! 원본 ${original.length}B / 재구성 ${rebuilt.length}B / canonical ${canonical.length}B`);
      // 첫 차이 지점 출력
      const a = rebuilt, b = canonical;
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      console.log(`     첫 차이 @${i}: rebuilt="${a.slice(i, i + 60)}" vs canonical="${b.slice(i, i + 60)}"`);
      problems++;
    }
  }
}

// ---------- 실행 ----------
function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  if (!verifyOnly) {
    console.log('== 마이그레이션 시작 ==');
    migrateBudget();
    migrateVrTrackers();
    migrateVrHistory();
    migrateExpense();
    migrateSummary();
    migrateExtMirror();
    setMeta('migrated_at', now());
  }
  verifyBudget();

  // 적재 결과 요약
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  console.log('\n== DB 적재 요약 ==');
  for (const t of ['budget_cell', 'budget_sheet', 'vr_tracker', 'vr_history', 'expense_month', 'ai_summary', 'ext_mirror']) {
    console.log(`  ${t}: ${count(t)}`);
  }
  if (problems) { console.error(`\n❌ 검증 실패 ${problems}건 — 중단`); process.exit(1); }
  console.log('\n✅ 완료 (검증 통과)');
}

main();
