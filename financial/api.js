// DB 기반 읽기 API (/api/*). 기존 파일 경로와 병행 — 라이브 전환은 P4 클라 컷오버에서.
// 쓰기(PATCH)·SSE는 P3/P4에서 이 라우터에 추가.
const express = require('express');
const store = require('./store');
const gitsync = require('./gitsync');
const { parseCSV } = require('./sheet');

const router = express.Router();
const SAVE_PASSWORD = process.env.SAVE_PASSWORD;

// 비밀번호 검사 (기존 /save와 동일 정책)
function checkPw(req, res) {
  const pw = (req.body && req.body.password) || req.get('X-Save-Password');
  if (SAVE_PASSWORD && pw !== SAVE_PASSWORD) { res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' }); return false; }
  return true;
}
const userOf = (req) => (req.body && req.body.user) || req.get('X-User') || null;

// 가계부 시트: 연도별 그리드 + 셀 버전맵
router.get('/budget/:year', (req, res) => {
  const b = store.getBudget(req.params.year);
  if (!b) return res.status(404).json({ error: 'year 없음' });
  res.json(b);
});
router.get('/budget', (req, res) => {
  res.json({ years: store.listBudgetYears() });
});

// VR 트래커 + 히스토리
router.get('/vr', (req, res) => {
  res.json(store.getVrTrackers());
});
router.get('/vr/history', (req, res) => {
  res.json(store.getVrHistory());
});

// 영수증 지출내역(전체 / 버전)
router.get('/expense', (req, res) => {
  res.json({ data: store.getExpenseAll(), versions: store.getExpenseVersions() });
});

// AI 월간 요약
router.get('/summary', (req, res) => {
  res.json(store.getSummary());
});

// ---------- 쓰기 (낙관적 잠금, 충돌 시 409) ----------

// 가계부 셀 1개 수정: { year, r, c, raw, baseVersion, password, user }
router.patch('/budget/cell', (req, res) => {
  if (!checkPw(req, res)) return;
  const { year, r, c, raw, baseVersion } = req.body || {};
  if (year == null || r == null || c == null) return res.status(400).json({ error: 'year, r, c 필요' });
  const out = store.applyCellPatch(year, r, c, raw, baseVersion ?? 0, userOf(req));
  if (out.error) return res.status(400).json({ error: out.error });
  if (out.conflict) return res.status(409).json({ conflict: true, current: out.current });
  broadcast({ type: 'budget-cell', year: Number(year), changed: out.changed, clientId: req.body.clientId });
  gitsync.afterBudgetChange(Number(year));
  res.json(out);
});

// 구조 변경(행 삽입/삭제): { year, csv | grid, baseSheetVersion, password }
router.put('/budget/:year/sheet', (req, res) => {
  if (!checkPw(req, res)) return;
  const year = req.params.year;
  let grid = req.body && req.body.grid;
  if (!grid && req.body && typeof req.body.csv === 'string') grid = parseCSV(req.body.csv);
  if (!Array.isArray(grid)) return res.status(400).json({ error: 'grid 또는 csv 필요' });
  const out = store.replaceBudgetSheet(year, grid, req.body.baseSheetVersion, userOf(req));
  if (out.conflict) return res.status(409).json(out);
  broadcast({ type: 'budget-sheet', year: Number(year), clientId: req.body.clientId });
  gitsync.afterBudgetChange(Number(year));
  res.json(out);
});

// VR 트래커 수정: { data, baseVersion, password }
router.patch('/vr/:ticker', (req, res) => {
  if (!checkPw(req, res)) return;
  const { data, baseVersion } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data 필요' });
  const out = store.applyVrPatch(req.params.ticker, data, baseVersion ?? 0, userOf(req));
  if (out.conflict) return res.status(409).json(out);
  broadcast({ type: 'vr', ticker: req.params.ticker, clientId: req.body.clientId });
  gitsync.afterVrChange();
  res.json(out);
});

// VR 트래커 삭제(사이클 종료 시): { password }
router.delete('/vr/:ticker', (req, res) => {
  if (!checkPw(req, res)) return;
  const out = store.deleteVrTracker(req.params.ticker);
  broadcast({ type: 'vr', ticker: req.params.ticker, clientId: req.body && req.body.clientId });
  gitsync.afterVrChange();
  res.json(out);
});

// VR 사이클 종료: { entry, password }
router.post('/vr/history', (req, res) => {
  if (!checkPw(req, res)) return;
  const entry = req.body && req.body.entry;
  if (!entry || typeof entry !== 'object') return res.status(400).json({ error: 'entry 필요' });
  const out = store.appendVrHistory(entry);
  broadcast({ type: 'vr-history' });
  gitsync.afterVrChange();
  res.json(out);
});

// 영수증 지출 월 수정: { year, month, data, baseVersion, password }
router.patch('/expense/:year/:month', (req, res) => {
  if (!checkPw(req, res)) return;
  const { data, baseVersion } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data 필요' });
  const out = store.applyExpensePatch(req.params.year, req.params.month, data, baseVersion, userOf(req));
  if (out.conflict) return res.status(409).json(out);
  broadcast({ type: 'expense', year: Number(req.params.year), month: Number(req.params.month), clientId: req.body.clientId });
  res.json(out);
});

// ---------- SSE (P4에서 클라 구독). 지금은 브로드캐스트 허브만 준비 ----------
const sseClients = new Set();
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch (_) {} }
}
gitsync.setBroadcast(broadcast);   // import(외부유입) 시 SSE로 클라 반영
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

module.exports = router;
