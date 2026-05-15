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

// 비밀번호 검증
function checkPassword(password, res) {
  if (SAVE_PASSWORD && password !== SAVE_PASSWORD) {
    res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

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
    res.status(500).json({ error: '파일 저장 실패: ' + e.message });
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

// 영수증 분석
app.post('/analyze-receipt', upload.single('file'), (req, res) => {
  const { password, year, month } = req.body || {};
  const file = req.file;

  if (!year || !month || !file) {
    return res.status(400).json({ error: 'year, month, file 필드가 필요합니다.' });
  }
  if (!checkPassword(password, res)) {
    fs.unlinkSync(file.path);
    return;
  }

  const allowedExts = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (!allowedExts.includes(ext)) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: '지원하지 않는 파일 형식입니다.' });
  }

  const fileName = `receipt-${Date.now()}.${ext}`;
  const destPath = path.join(ROOT, 'tmp', fileName);
  fs.renameSync(file.path, destPath);

  const script = path.join(ROOT, 'analyze-receipt.sh');
  res.json({
    ok: true,
    message: `${year}년 ${month}월 영수증 분석이 시작되었습니다. 잠시 후 반영됩니다.`,
    fileName,
  });

  // 분석은 백그라운드로 실행
  execFile('bash', [script, year, month.padStart(2, '0'), fileName], {
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
