const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = 3000;
const ROOT = __dirname;
const SAVE_PASSWORD = process.env.SAVE_PASSWORD;
const RECORD_TOKEN = process.env.RECORD_TOKEN;

const upload = multer({ dest: path.join(ROOT, 'tmp') });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT));
app.use('/infinite-buy', express.static(path.join(ROOT, '../infinite-buy')));
app.use('/lotto', express.static(path.join(ROOT, '../lotto')));

// AI 리포트 생성 상태
let reportState = { generating: false, current: null, queue: [], lastUpdated: null, error: null };

// 마지막 리포트 생성 시점의 CSV 해시 (변경감지용, 서버 재시작 시 초기화)
let reportHashMap = {};

function csvHash(year) {
  const p = path.join(ROOT, `${year}.csv`);
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

function processQueue() {
  if (reportState.generating || reportState.queue.length === 0) return;
  const { year, month } = reportState.queue.shift();
  reportState = { ...reportState, generating: true, current: { year, month }, lastUpdated: Date.now(), error: null };
  execFile('bash', [path.join(ROOT, 'generate-report.sh'), year, month], {
    cwd: ROOT,
    env: { ...process.env, HOME: process.env.HOME || '/Users/mac_ad03249840' },
  }, (err, stdout) => {
    if (err) console.error('[generate-report] 실패:', err.message);
    else console.log('[generate-report] 완료:', stdout.slice(-120));
    reportState = { ...reportState, generating: false, current: null, lastUpdated: Date.now(), error: err?.message || null };
    processQueue();
  });
}

function triggerReport(year, month) {
  const key = `${year}-${month}`;
  if ((reportState.current && `${reportState.current.year}-${reportState.current.month}` === key) ||
      reportState.queue.find(q => `${q.year}-${q.month}` === key)) return;
  reportState = { ...reportState, queue: [...reportState.queue, { year, month }] };
  processQueue();
}

// 비밀번호 검증
function checkPassword(password, res) {
  if (SAVE_PASSWORD && password !== SAVE_PASSWORD) {
    res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

// AI 리포트 상태 조회
app.get('/report-status', (req, res) => {
  res.json(reportState);
});

// AI 리포트 수동 트리거
app.post('/trigger-report', (req, res) => {
  const { password, year, month } = req.body || {};
  if (!checkPassword(password, res)) return;
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = year || String(kst.getFullYear());
  const m = month || String(kst.getMonth() + 1);
  // 직전 생성 시점과 CSV 변경사항 비교
  const currentHash = csvHash(y);
  const hashKey = `${y}-${m}`;
  if (currentHash && reportHashMap[hashKey] === currentHash) {
    return res.json({ ok: false, noChange: true, message: '변경사항 없음' });
  }
  reportHashMap[hashKey] = currentHash;

  triggerReport(y, m);
  res.json({ ok: true, message: `${y}년 ${m}월 리포트 생성 시작` });
});

// 가계부 CSV 저장
app.post('/save', (req, res) => {
  const { password, year, content } = req.body || {};
  if (!year || !content) return res.status(400).json({ error: 'year, content 필드가 필요합니다.' });
  if (!checkPassword(password, res)) return;

  const bom = '﻿';
  const filePath = path.join(ROOT, `${year}.csv`);
  try {
    fs.writeFileSync(filePath, bom + content, 'utf8');
    res.json({ ok: true, message: `${year}.csv 저장 완료` });
  } catch (e) {
    return res.status(500).json({ error: '파일 저장 실패: ' + e.message });
  }
});

// VR 계산기 상태 저장
app.post('/save-vr', (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content 필드가 필요합니다.' });
  const filePath = path.join(ROOT, 'vr-state.json');
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true, message: 'vr-state.json 저장 완료' });
  } catch (e) {
    res.status(500).json({ error: '파일 저장 실패: ' + e.message });
  }
});

// VR 사이클 종료 시 히스토리에 append
app.post('/save-vr-history', (req, res) => {
  const { entry } = req.body || {};
  if (!entry || typeof entry !== 'object') return res.status(400).json({ error: 'entry 필드가 필요합니다.' });
  const filePath = path.join(ROOT, 'vr-history.json');
  try {
    let arr = [];
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (raw) arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    }
    arr.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    res.json({ ok: true, message: 'vr-history.json append 완료', total: arr.length });
  } catch (e) {
    res.status(500).json({ error: '히스토리 저장 실패: ' + e.message });
  }
});

// 영수증 분석
app.post('/analyze-receipt', upload.single('file'), (req, res) => {
  const { password, year, month } = req.body || {};
  const file = req.file;
  if (!year || !month || !file) return res.status(400).json({ error: 'year, month, file 필드가 필요합니다.' });
  if (!checkPassword(password, res)) { fs.unlinkSync(file.path); return; }

  const allowedExts = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (!allowedExts.includes(ext)) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: '지원하지 않는 파일 형식입니다.' });
  }

  const fileName = `receipt-${Date.now()}.${ext}`;
  fs.renameSync(file.path, path.join(ROOT, 'tmp', fileName));

  res.json({ ok: true, message: `${year}년 ${month}월 영수증 분석이 시작되었습니다. 잠시 후 반영됩니다.`, fileName });

  execFile('bash', [path.join(ROOT, 'analyze-receipt.sh'), year, month.padStart(2, '0'), fileName], {
    cwd: ROOT,
    env: { ...process.env, HOME: process.env.HOME || '/Users/mac_ad03249840' },
  }, (err, stdout, stderr) => {
    if (err) console.error('[analyze-receipt] 실패:', stderr || err.message);
    else console.log('[analyze-receipt] 완료:', stdout.slice(-200));
  });
});

// expense_detail.json 조회
app.get('/expense-detail', (req, res) => {
  const filePath = path.join(ROOT, 'expense_detail.json');
  try {
    const data = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// expense_detail.json 저장 (메모 포함)
app.post('/save-expense-detail', (req, res) => {
  const { password, content } = req.body || {};
  if (!checkPassword(password, res)) return;
  if (!content) return res.status(400).json({ error: 'content 필드가 필요합니다.' });
  const filePath = path.join(ROOT, 'expense_detail.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
    res.json({ ok: true, message: 'expense_detail.json 저장 완료' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Siri 단축어 음성 가계부 입력
app.post('/api/record', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!RECORD_TOKEN || !auth.startsWith('Bearer ') || auth.slice(7) !== RECORD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const text = req.body && req.body.text ? String(req.body.text).trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });

  res.status(202).json({ ok: true, message: '기록 처리 중' });

  execFile('bash', [path.join(ROOT, 'record-text.sh'), text], {
    cwd: ROOT,
    env: { ...process.env, HOME: process.env.HOME || '/Users/mac_ad03249840' },
  }, (err, stdout, stderr) => {
    if (err) console.error('[record-text] 실패:', stderr || err.message);
    else console.log('[record-text] 완료:', stdout.slice(-300));
  });
});

app.listen(PORT, () => {
  console.log(`Homi financial server running on http://localhost:${PORT}`);
});
