// Git 동기화 브리지: DB(authoritative) ↔ git(사람이 읽는 export/백업, CI·타기기 교환).
// - 나감: DB 변경 → export 파일 재작성 → 디바운스 git add/commit/pull/push
// - 들어옴: pull/외부(CI·영수증)로 파일이 바뀌면 → DB import → SSE 브로드캐스트
// - 에코 방지: 내가 export한 파일 해시를 meta에 기록 → 그 해시와 다르면만 "외부 유입"으로 판단
// 설계: financial/docs/db-migration-plan.md (P5)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { db, getMeta, setMeta } = require('./db');
const store = require('./store');
const { toCSVFile, parseCSV } = require('./sheet');

const ROOT = __dirname;                 // financial/
const REPO = path.join(ROOT, '..');     // repo root
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const fileHash = (p) => { try { return md5(fs.readFileSync(p)); } catch (e) { return null; } };
const now = () => new Date().toISOString();

let broadcastFn = () => {};
function setBroadcast(fn) { broadcastFn = fn; }

// ---------------- EXPORT (DB → 파일) ----------------
function writeAndRecord(rel, text) {
  const p = path.join(ROOT, rel);
  fs.writeFileSync(p, text, 'utf8');
  setMeta('filehash:' + rel, md5(Buffer.from(text)));   // 내 export 해시 기록(에코 방지)
  return rel;
}
function exportBudget(year) {
  const built = store.rebuildGrid(year);
  if (!built) return null;
  return writeAndRecord(`${year}.csv`, toCSVFile(built.grid));
}
function exportVr() {
  const { trackers } = store.getVrTrackers();
  writeAndRecord('vr-state.json', JSON.stringify(trackers, null, 2));
  writeAndRecord('vr-history.json', JSON.stringify(store.getVrHistory(), null, 2) + '\n');
  return ['vr-state.json', 'vr-history.json'];
}

// ---------------- COMMIT (디바운스) ----------------
const timers = {};
function scheduleCommit(files, msg) {
  const key = files.slice().sort().join('|');
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    delete timers[key];
    const addArgs = files.map(f => JSON.stringify(f)).join(' ');
    const cmd = `git add ${addArgs} && (git diff --staged --quiet || (git commit -m ${JSON.stringify(msg)} && (git pull --rebase --autostash || true) && (git push || true)))`;
    execFile('bash', ['-c', cmd], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) console.error('[gitsync] commit 실패:', (stderr || err.message).slice(-300));
      else console.log('[gitsync]', msg);
      importChangedFiles();   // pull로 들어온 외부 변경 반영
    });
  }, 5000);
}

// api 라우트가 쓰기 성공 후 호출
function afterBudgetChange(year) { const f = exportBudget(year); if (f) scheduleCommit([f], `가계부 ${year}.csv 자동 저장`); }
function afterVrChange() { scheduleCommit(exportVr(), 'VR 상태 자동 저장'); }

// ---------------- IMPORT (파일 → DB) : CI·영수증·타기기 유입 ----------------
function importBudgetFile(year, text) {
  const grid = parseCSV(text);
  const nRows = grid.length, nCols = grid.length ? Math.max(...grid.map(r => r.length)) : 0;
  const up = db.prepare(`INSERT INTO budget_cell (year,r,c,raw,version,updated_at,updated_by)
    VALUES (?,?,?,?,COALESCE((SELECT version FROM budget_cell WHERE year=? AND r=? AND c=?),0)+1,?, 'git')
    ON CONFLICT(year,r,c) DO UPDATE SET raw=excluded.raw, version=excluded.version, updated_at=excluded.updated_at, updated_by='git'`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM budget_cell WHERE year=?').run(Number(year));
    for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c]; if (v !== '' && v != null) up.run(Number(year), r, c, String(v), Number(year), r, c, now());
    }
    db.prepare(`INSERT INTO budget_sheet (year,n_rows,n_cols,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(year) DO UPDATE SET n_rows=excluded.n_rows,n_cols=excluded.n_cols,updated_at=excluded.updated_at`).run(Number(year), nRows, nCols, now());
  });
  tx();
  broadcastFn({ type: 'budget-sheet', year: Number(year), source: 'git' });
}
function importVrState(text) {
  const data = JSON.parse(text);
  const up = db.prepare(`INSERT INTO vr_tracker (ticker,data,version,updated_at,updated_by)
    VALUES (?,?,COALESCE((SELECT version FROM vr_tracker WHERE ticker=?),0)+1,?, 'git')
    ON CONFLICT(ticker) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at, updated_by='git'`);
  const keep = new Set(Object.keys(data));
  const tx = db.transaction(() => {
    for (const [ticker, obj] of Object.entries(data)) up.run(ticker, JSON.stringify(obj), ticker, now());
    for (const r of db.prepare('SELECT ticker FROM vr_tracker').all()) if (!keep.has(r.ticker)) db.prepare('DELETE FROM vr_tracker WHERE ticker=?').run(r.ticker);
  });
  tx();
  broadcastFn({ type: 'vr', source: 'git' });
}
function importVrHistory(text) {
  const arr = JSON.parse(text);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vr_history').run();
    const ins = db.prepare('INSERT INTO vr_history (ticker, ended_at, data, version) VALUES (?,?,?,1)');
    for (const e of arr) ins.run(e.ticker || '', e.endedAt || e.lastUpdated || '', JSON.stringify(e));
  });
  tx();
  broadcastFn({ type: 'vr-history', source: 'git' });
}
function importExpense(text) {
  const data = JSON.parse(text);
  const up = db.prepare(`INSERT INTO expense_month (year,month,data,version,updated_at,updated_by)
    VALUES (?,?,?,COALESCE((SELECT version FROM expense_month WHERE year=? AND month=?),0)+1,?, 'git')
    ON CONFLICT(year,month) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at, updated_by='git'`);
  const tx = db.transaction(() => {
    for (const [y, months] of Object.entries(data)) for (const [mm, obj] of Object.entries(months))
      up.run(Number(y), Number(mm), JSON.stringify(obj), Number(y), Number(mm), now());
  });
  tx();
  broadcastFn({ type: 'expense', source: 'git' });
}
function importSummary(text) {
  const data = JSON.parse(text);
  const up = db.prepare(`INSERT INTO ai_summary (year,month,data,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(year,month) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
  const tx = db.transaction(() => {
    for (const [y, months] of Object.entries(data)) for (const [mm, obj] of Object.entries(months))
      up.run(Number(y), Number(mm), JSON.stringify(obj), now());
  });
  tx();
  broadcastFn({ type: 'summary', source: 'git' });
}

// 파일 해시가 "내 export 해시"와 다르면 = 외부 유입 → import
function importJsonIfChanged(rel, importer) {
  const p = path.join(ROOT, rel);
  const fh = fileHash(p);
  if (!fh) return;
  if (fh === getMeta('filehash:' + rel)) return;         // 내가 쓴 것
  try { importer(fs.readFileSync(p, 'utf8')); setMeta('filehash:' + rel, fh); console.log('[gitsync] import(외부유입):', rel); }
  catch (e) { console.error('[gitsync] import 실패:', rel, e.message); }
}
function importChangedFiles() {
  for (const y of store.listBudgetYears()) {
    const rel = `${y}.csv`, p = path.join(ROOT, rel), fh = fileHash(p);
    if (fh && fh !== getMeta('filehash:' + rel)) {
      try { importBudgetFile(y, fs.readFileSync(p, 'utf8')); setMeta('filehash:' + rel, fh); console.log('[gitsync] import(외부유입):', rel); }
      catch (e) { console.error('[gitsync] import 실패:', rel, e.message); }
    }
  }
  importJsonIfChanged('vr-state.json', importVrState);
  importJsonIfChanged('vr-history.json', importVrHistory);
  importJsonIfChanged('expense_detail.json', importExpense);
  importJsonIfChanged('summary.json', importSummary);
}

// 최초 부팅: 파일해시 기준선이 없으면 현재 파일로 설정(부팅 시 불필요한 import 방지).
// 기준선이 이미 있으면(재부팅) importChangedFiles가 서버 정지 중 유입을 흡수.
function initBaseline() {
  const rels = ['2025.csv', '2026.csv', 'vr-state.json', 'vr-history.json', 'expense_detail.json', 'summary.json'];
  let anyMissing = false;
  for (const rel of rels) if (getMeta('filehash:' + rel) == null) { const fh = fileHash(path.join(ROOT, rel)); if (fh) { setMeta('filehash:' + rel, fh); anyMissing = true; } }
  if (anyMissing) console.log('[gitsync] 파일 해시 기준선 설정 완료');
}

// 주기적 pull → 외부(타기기/CI push) 변경 흡수
let pollTimer = null;
function startPeriodicSync(intervalMs = 60000) {
  initBaseline();
  importChangedFiles(); // 부팅 시 정지 중 유입 1회 반영
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    execFile('bash', ['-c', 'git pull --rebase --autostash || true'], { cwd: ROOT }, () => importChangedFiles());
  }, intervalMs);
}

module.exports = {
  setBroadcast, exportBudget, exportVr,
  afterBudgetChange, afterVrChange,
  importChangedFiles, initBaseline, startPeriodicSync,
};
