const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// 영수증 분석 카테고리 (analyze-only.sh / analyze-receipt.sh와 동일하게 유지)
const CANONICAL_CATEGORIES = ['외식/카페', '생활비', '쇼핑', '통신비', '관리비', '도시가스', '유류비', '콘텐츠', '의료', '교통', '경조사비', '여가/레저', '기타(메모입력)'];

const app = express();
const PORT = 3000;
const ROOT = __dirname;
const SAVE_PASSWORD = process.env.SAVE_PASSWORD;
const RECORD_TOKEN = process.env.RECORD_TOKEN;

const upload = multer({ dest: path.join(ROOT, 'tmp') });

app.use(express.json({ limit: '10mb' }));

// DB 기반 읽기 API (P2~). 기존 파일 경로와 병행, 라이브 전환은 P4에서.
app.use('/api', require('./api'));

app.use(express.static(ROOT));
app.use('/infinite-buy', express.static(path.join(ROOT, '../infinite-buy')));
app.use('/lotto', express.static(path.join(ROOT, '../lotto')));

// 저장 직후 자동 git commit & push (debounce: 같은 파일 5초 내 재저장 시 합침)
const autoCommitTimers = {};
function autoCommit(files, message) {
  const key = files.slice().sort().join('|');
  clearTimeout(autoCommitTimers[key]);
  autoCommitTimers[key] = setTimeout(() => {
    delete autoCommitTimers[key];
    const addArgs = files.map(f => JSON.stringify(f)).join(' ');
    const cmd = `git add ${addArgs} && (git diff --staged --quiet || (git commit -m ${JSON.stringify(message)} && (git pull --rebase --autostash || true) && (git push || true)))`;
    execFile('bash', ['-c', cmd], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) console.error('[auto-commit] 실패:', (stderr || err.message).slice(-300));
      else console.log(`[auto-commit] ${message}`);
    });
  }, 5000);
}

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
  // 타임아웃 안전망: 어떤 이유로든 멈춰도 8분 후 강제 종료해 generating 플래그를 풀어준다
  // (progress가 영원히 안 끝나는 것 방지)
  execFile('bash', [path.join(ROOT, 'generate-report.sh'), year, month], {
    cwd: ROOT,
    env: { ...process.env, HOME: process.env.HOME || '/Users/mac_ad03249840' },
    timeout: 8 * 60 * 1000,
    killSignal: 'SIGKILL',
  }, (err, stdout) => {
    if (err) console.error('[generate-report] 실패:', err.killed ? '타임아웃(8분 초과)' : err.message);
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
    autoCommit([`${year}.csv`], `가계부 ${year}.csv 자동 저장`);
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
    autoCommit(['vr-state.json'], 'VR state 자동 저장');
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
    autoCommit(['vr-history.json', 'vr-state.json'], 'VR 사이클 종료: history append');
  } catch (e) {
    res.status(500).json({ error: '히스토리 저장 실패: ' + e.message });
  }
});

// ===== 영수증 분석 (대화형: 복호화→분석→검토→저장) =====
// 진행 단계를 폴링으로 추적하고, 분석 결과를 사용자가 검토/수정 후 저장하는 플로우.
const analyzeJobs = new Map(); // jobId -> { stage, items, error, warning, fileName, createdAt }

function makeEnv() {
  return { ...process.env, HOME: process.env.HOME || '/Users/mac_ad03249840' };
}

// 오래된 job 정리 (30분 경과분)
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of analyzeJobs) {
    if (now - j.createdAt > 30 * 60 * 1000) analyzeJobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

// 사용 가능한 모든 카테고리 (기본 + 기존 데이터에 등장한 것)
function allCategories() {
  const set = new Set(CANONICAL_CATEGORIES);
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'expense_detail.json'), 'utf8'));
    for (const y of Object.values(d)) {
      for (const m of Object.values(y)) {
        for (const it of (m.items || [])) {
          const c = it['카테고리'];
          if (c && c !== '제외') set.add(c);
        }
      }
    }
  } catch (e) { /* 무시 */ }
  return [...set];
}

app.get('/expense-categories', (req, res) => {
  res.json({ categories: allCategories() });
});

// 1단계: 분석 시작 → jobId 즉시 반환, 백그라운드에서 복호화+분석 진행
app.post('/analyze-receipt', upload.single('file'), (req, res) => {
  const { password, decryptPassword } = req.body || {};
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file 필드가 필요합니다.' });
  if (!checkPassword(password, res)) { fs.unlinkSync(file.path); return; }

  const allowedExts = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'html', 'htm'];
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (!allowedExts.includes(ext)) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: '지원하지 않는 파일 형식입니다.' });
  }
  if ((ext === 'html' || ext === 'htm') && !decryptPassword) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'HTML 파일은 복호화 비밀번호가 필요합니다.' });
  }

  const fileName = `receipt-${Date.now()}.${ext}`;
  const filePath = path.join(ROOT, 'tmp', fileName);
  fs.renameSync(file.path, filePath);

  const jobId = crypto.randomBytes(8).toString('hex');
  analyzeJobs.set(jobId, { stage: 'uploading', items: null, error: null, warning: null, createdAt: Date.now() });
  res.json({ ok: true, jobId });

  runAnalyzeJob(jobId, filePath, ext, decryptPassword).catch((e) => {
    const job = analyzeJobs.get(jobId);
    if (job) { job.stage = 'error'; job.error = (e && e.message) || String(e); }
  });
});

async function runAnalyzeJob(jobId, filePath, ext, decryptPassword) {
  const job = analyzeJobs.get(jobId);
  const env = makeEnv();
  let analyzePath = filePath;

  if (ext === 'html' || ext === 'htm') {
    job.stage = 'decrypting';
    // decrypt가 stdout으로 @@STAGE:rendering / @@STAGE:pdf 를 흘려보냄 → job.stage 갱신
    await new Promise((resolve, reject) => {
      const p = spawn(path.join(ROOT, '.venv/bin/python'), ['decrypt_samsungcard.py', filePath, decryptPassword], { cwd: ROOT, env });
      let stderr = '';
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const m = line.match(/^@@STAGE:(\w+)/);
          if (m) job.stage = m[1] === 'pdf' ? 'converting' : 'decrypting';
        }
      });
      p.stderr.on('data', (d) => { stderr += d.toString(); });
      p.on('close', (code) => {
        if (code === 0) return resolve();
        const tail = stderr.trim().split('\n').pop() || '';
        if (code === 2) return reject(new Error('복호화 실패: 비밀번호가 틀렸습니다.'));
        reject(new Error('복호화 실패: ' + (tail || ('exit ' + code)).slice(-200)));
      });
    });
    const decryptedPdf = filePath.replace(/\.html?$/i, '_decrypted.pdf');
    const decryptedTxt = filePath.replace(/\.html?$/i, '_decrypted.txt');
    if (!fs.existsSync(decryptedPdf)) throw new Error('복호화 완료했으나 PDF 생성 실패');
    if (fs.existsSync(decryptedTxt) && fs.readFileSync(decryptedTxt, 'utf8').trim().length < 200) {
      throw new Error('복호화 실패: 본문 추출이 비어있습니다.');
    }
    analyzePath = decryptedPdf;
  }

  // 분석 (Claude vision → JSON 항목)
  job.stage = 'analyzing';
  const analyzeName = path.basename(analyzePath);
  const stdout = await new Promise((resolve, reject) => {
    execFile('bash', [path.join(ROOT, 'analyze-only.sh'), analyzeName], { cwd: ROOT, env, maxBuffer: 10 * 1024 * 1024 }, (err, out, serr) => {
      if (err) return reject(new Error('분석 실패: ' + ((serr || err.message) || '').toString().slice(-200)));
      resolve(out);
    });
  });

  let items;
  try {
    let raw = stdout.trim();
    if (raw.startsWith('```')) raw = raw.split('\n').slice(1, -1).join('\n');
    items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error('배열이 아님');
  } catch (e) {
    throw new Error('분석 결과 파싱 실패: ' + stdout.slice(0, 200));
  }

  // 각 항목에 기본 포함 상태 부여
  job.items = items.map((it) => ({ ...it, _include: it['카테고리'] !== '제외' }));
  job.stage = 'done';
}

// 2단계: 진행 상태 폴링
app.get('/analyze-status/:jobId', (req, res) => {
  const job = analyzeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job 없음 (만료되었거나 잘못된 id)' });
  res.json({
    stage: job.stage,
    items: job.stage === 'done' ? job.items : null,
    error: job.error,
    categories: job.stage === 'done' ? allCategories() : null,
  });
});

// 3단계: 사용자가 검토·수정한 항목을 시트에 반영
app.post('/save-expense-items', (req, res) => {
  const { password, year, items } = req.body || {};
  if (!checkPassword(password, res)) return;
  if (!year || !Array.isArray(items)) return res.status(400).json({ error: 'year, items 필드가 필요합니다.' });

  // 제외(_include=false)된 항목은 빼고, 내부 필드 정리
  const clean = items
    .filter((it) => it && it._include !== false)
    .map(({ 날짜, 가맹점, 카드, 금액, 카테고리, 메모 }) => ({ 날짜, 가맹점, 카드, 금액: parseInt(금액) || 0, 카테고리, ...(메모 ? { 메모 } : {}) }));

  if (!clean.length) return res.json({ ok: true, message: '반영할 항목이 없습니다.', count: 0 });

  const months = [...new Set(clean.map((it) => (it.날짜 || '').split('.')[0].padStart(2, '0')).filter(Boolean))];
  const defaultMonth = months[0] || '01';
  const env = makeEnv();

  execFile('python3', [path.join(ROOT, 'update-expense.py'), String(year), defaultMonth, JSON.stringify(clean)], { cwd: ROOT, env }, (err, stdout, stderr) => {
    if (err) {
      console.error('[save-expense-items] 실패:', stderr || err.message);
      return res.status(500).json({ error: '시트 반영 실패: ' + ((stderr || err.message) || '').toString().slice(-200) });
    }
    res.json({ ok: true, message: `${clean.length}개 항목 반영 완료`, count: clean.length, months });
    autoCommit(['expense_detail.json', `${year}.csv`], `영수증 분석 반영: ${clean.length}건`);
    // 리포트는 백그라운드 재생성 (시트 반영 완료 후)
    for (const m of months) {
      execFile('bash', [path.join(ROOT, 'generate-report.sh'), String(year), m], { cwd: ROOT, env }, (e) => {
        if (e) console.error('[generate-report] 실패:', e.message);
      });
    }
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
    autoCommit(['expense_detail.json'], 'expense_detail.json 자동 저장 (메모 포함)');
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
