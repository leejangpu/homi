// 데이터 접근 계층 — DB 읽기/쓰기 함수. api.js(HTTP), git export(P5)에서 공용.
const { db } = require('./db');
const { analyzeSections, recomputeTotals } = require('./sheet');

const nowISO = () => new Date().toISOString();

// ---------- 가계부 시트 ----------
function rebuildGrid(year) {
  const meta = db.prepare('SELECT n_rows, n_cols FROM budget_sheet WHERE year = ?').get(Number(year));
  if (!meta) return null;
  const grid = Array.from({ length: meta.n_rows }, () => Array(meta.n_cols).fill(''));
  const cells = db.prepare('SELECT r, c, raw FROM budget_cell WHERE year = ?').all(Number(year));
  for (const { r, c, raw } of cells) if (r < meta.n_rows && c < meta.n_cols) grid[r][c] = raw ?? '';
  return { grid, nRows: meta.n_rows, nCols: meta.n_cols };
}

function getBudget(year) {
  const built = rebuildGrid(year);
  if (!built) return null;
  const versions = {};
  for (const { r, c, version } of db.prepare('SELECT r, c, version FROM budget_cell WHERE year = ?').all(Number(year))) {
    versions[r + ',' + c] = version;
  }
  const { monthStart, headerRow } = analyzeSections(built.grid);
  return { year: Number(year), monthStart, headerRow, nRows: built.nRows, nCols: built.nCols, grid: built.grid, versions };
}

function listBudgetYears() {
  return db.prepare('SELECT year FROM budget_sheet ORDER BY year').all().map(r => String(r.year));
}

// ---------- VR ----------
function getVrTrackers() {
  const rows = db.prepare('SELECT ticker, data, version FROM vr_tracker').all();
  const trackers = {}, versions = {};
  for (const r of rows) { trackers[r.ticker] = JSON.parse(r.data); versions[r.ticker] = r.version; }
  return { trackers, versions };
}
function getVrHistory() {
  return db.prepare('SELECT ticker, ended_at, data FROM vr_history ORDER BY id').all().map(r => JSON.parse(r.data));
}

// ---------- 영수증 지출 ----------
function getExpenseAll() {
  const out = {};
  for (const r of db.prepare('SELECT year, month, data FROM expense_month ORDER BY year, month').all()) {
    const y = String(r.year), mm = String(r.month).padStart(2, '0');
    (out[y] = out[y] || {})[mm] = JSON.parse(r.data);
  }
  return out;
}
function getExpenseVersions() {
  const v = {};
  for (const r of db.prepare('SELECT year, month, version FROM expense_month').all()) v[r.year + '-' + String(r.month).padStart(2, '0')] = r.version;
  return v;
}

// ---------- AI 요약 ----------
function getSummary() {
  const out = {};
  for (const r of db.prepare('SELECT year, month, data FROM ai_summary ORDER BY year, month').all()) {
    const y = String(r.year), mm = String(r.month).padStart(2, '0');
    (out[y] = out[y] || {})[mm] = JSON.parse(r.data);
  }
  return out;
}

// ---------- 외부 미러 ----------
function getExtMirror(source, key) {
  const r = db.prepare('SELECT data FROM ext_mirror WHERE source = ? AND key = ?').get(source, key);
  return r ? JSON.parse(r.data) : null;
}

// ---------- 쓰기: 가계부 셀 PATCH (낙관적 잠금) ----------
// 반환: {conflict, current} | {ok, changed:[{r,c,raw,version}]}
// changed에는 편집 셀 + 재계산으로 바뀐 합계 셀이 모두 포함(클라 반영/SSE 브로드캐스트용).
const _upsertCell = db.prepare(
  `INSERT INTO budget_cell (year, r, c, raw, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(year, r, c) DO UPDATE SET raw=excluded.raw, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`
);
const _delCell = db.prepare('DELETE FROM budget_cell WHERE year=? AND r=? AND c=?');
const _getCellVer = db.prepare('SELECT version FROM budget_cell WHERE year=? AND r=? AND c=?');

function applyCellPatch(year, r, c, raw, baseVersion, user) {
  year = Number(year); r = Number(r); c = Number(c);
  const cur = db.prepare('SELECT raw, version FROM budget_cell WHERE year=? AND r=? AND c=?').get(year, r, c);
  const curVer = cur ? cur.version : 0;              // 빈 셀 = version 0
  if (Number(baseVersion) !== curVer) {
    return { conflict: true, current: { raw: cur ? cur.raw : '', version: curVer } };
  }
  const built = rebuildGrid(year);
  if (!built) return { error: 'year 없음' };
  const oldGrid = built.grid;
  const newGrid = oldGrid.map(row => row.slice());
  if (r >= newGrid.length || c >= (newGrid[r] || []).length) return { error: '셀 범위 초과' };
  newGrid[r][c] = String(raw ?? '');
  recomputeTotals(newGrid);                          // 편집 셀로 인해 바뀌는 합계까지 반영

  const changed = [];
  const tx = db.transaction(() => {
    for (let rr = 0; rr < newGrid.length; rr++) {
      for (let cc = 0; cc < newGrid[rr].length; cc++) {
        const before = oldGrid[rr][cc] || '';
        const after = newGrid[rr][cc] || '';
        if (before === after) continue;
        const ex = _getCellVer.get(year, rr, cc);
        const nv = (ex ? ex.version : 0) + 1;
        if (after === '') { _delCell.run(year, rr, cc); changed.push({ r: rr, c: cc, raw: '', version: 0 }); }
        else { _upsertCell.run(year, rr, cc, after, nv, nowISO(), user || null); changed.push({ r: rr, c: cc, raw: after, version: nv }); }
      }
    }
  });
  tx();
  return { ok: true, changed };
}

// 구조 변경(행 삽입/삭제 등)용: 클라가 보낸 전체 그리드로 교체. 시트 버전으로 가드.
function replaceBudgetSheet(year, grid, baseSheetVersion, user) {
  year = Number(year);
  const meta = db.prepare('SELECT n_rows, n_cols FROM budget_sheet WHERE year=?').get(year);
  const sheetVerRow = db.prepare("SELECT v FROM meta WHERE k=?").get('budget_sheet_ver:' + year);
  const curSheetVer = sheetVerRow ? Number(sheetVerRow.v) : 1;
  if (baseSheetVersion != null && Number(baseSheetVersion) !== curSheetVer) {
    return { conflict: true, currentSheetVersion: curSheetVer };
  }
  recomputeTotals(grid);
  const nRows = grid.length, nCols = grid.length ? Math.max(...grid.map(r => r.length)) : 0;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM budget_cell WHERE year=?').run(year);
    for (let rr = 0; rr < grid.length; rr++)
      for (let cc = 0; cc < grid[rr].length; cc++) {
        const v = grid[rr][cc];
        if (v !== '' && v != null) _upsertCell.run(year, rr, cc, String(v), 1, nowISO(), user || null);
      }
    db.prepare(`INSERT INTO budget_sheet (year,n_rows,n_cols,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(year) DO UPDATE SET n_rows=excluded.n_rows,n_cols=excluded.n_cols,updated_at=excluded.updated_at`).run(year, nRows, nCols, nowISO());
    db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run('budget_sheet_ver:' + year, String(curSheetVer + 1));
  });
  tx();
  return { ok: true, sheetVersion: curSheetVer + 1 };
}

// ---------- 쓰기: VR 트래커 PATCH (낙관적 잠금) ----------
function applyVrPatch(ticker, data, baseVersion, user) {
  const cur = db.prepare('SELECT version FROM vr_tracker WHERE ticker=?').get(ticker);
  const curVer = cur ? cur.version : 0;
  if (Number(baseVersion) !== curVer) return { conflict: true, current: getVrTrackers().trackers[ticker] || null, currentVersion: curVer };
  const nv = curVer + 1;
  db.prepare(`INSERT INTO vr_tracker (ticker, data, version, updated_at, updated_by) VALUES (?,?,?,?,?)
    ON CONFLICT(ticker) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(ticker, JSON.stringify(data), nv, nowISO(), user || null);
  return { ok: true, version: nv };
}

function deleteVrTracker(ticker) {
  const info = db.prepare('DELETE FROM vr_tracker WHERE ticker=?').run(ticker);
  return { ok: true, deleted: info.changes };
}

function appendVrHistory(entry) {
  db.prepare('INSERT INTO vr_history (ticker, ended_at, data, version) VALUES (?,?,?,1)')
    .run(entry.ticker || '', entry.endedAt || entry.lastUpdated || nowISO(), JSON.stringify(entry));
  return { ok: true, total: db.prepare('SELECT COUNT(*) n FROM vr_history').get().n };
}

// ---------- 쓰기: 영수증 지출 월 PATCH (낙관적 잠금) ----------
function applyExpensePatch(year, month, data, baseVersion, user) {
  year = Number(year); month = Number(month);
  const cur = db.prepare('SELECT version FROM expense_month WHERE year=? AND month=?').get(year, month);
  const curVer = cur ? cur.version : 0;
  if (baseVersion != null && Number(baseVersion) !== curVer) return { conflict: true, currentVersion: curVer };
  const nv = curVer + 1;
  db.prepare(`INSERT INTO expense_month (year, month, data, version, updated_at, updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(year, month) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(year, month, JSON.stringify(data), nv, nowISO(), user || null);
  return { ok: true, version: nv };
}

module.exports = {
  rebuildGrid, getBudget, listBudgetYears,
  getVrTrackers, getVrHistory,
  getExpenseAll, getExpenseVersions,
  getSummary, getExtMirror,
  applyCellPatch, replaceBudgetSheet,
  applyVrPatch, deleteVrTracker, appendVrHistory, applyExpensePatch,
};
