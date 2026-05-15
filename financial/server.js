const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
const PORT = 3000;
const ROOT = __dirname;
const SAVE_PASSWORD = process.env.SAVE_PASSWORD;

const upload = multer({ dest: path.join(ROOT, 'tmp') });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT));

// AI 리포트 생성 상태
let reportState = { generating: false, lastUpdated: null, error: null };

function triggerReport(year, month) {
  if (reportState.generating) return;
  reportState = { generating: true, lastUpdated: Date.now(), error: null };
  execFile('bash', [path.join(ROOT, 'generate-report.sh'), year, month], {
    cwd: ROOT,
    env: { ...process.env, HOME: process.env.HOME || '/Users/mac_ad03249840' },
  }, (err, stdout) => {
    reportState = { generating: false, lastUpdated: Date.now(), error: err?.message || null };
    if (err) console.error('[generate-report] 실패:', err.message);
    else console.log('[generate-report] 완료:', stdout.slice(-120));
  });
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
  if (reportState.generating) return res.json({ ok: true, message: '이미 생성 중입니다.' });
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

  // 저장 후 AI 리포트 자동 재생성
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  triggerReport(year, String(kst.getMonth() + 1));
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

app.listen(PORT, () => {
  console.log(`Homi financial server running on http://localhost:${PORT}`);
});
