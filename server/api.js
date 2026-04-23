import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = process.env.PORT || 3456;

const app = express();
app.use(cors());
app.use(express.json());

// ==================== VR State ====================

const VR_STATE_PATH = resolve(ROOT, 'financial/vr-state.json');

// GET /api/vr/load
app.get('/api/vr/load', (_req, res) => {
  try {
    if (!existsSync(VR_STATE_PATH)) {
      return res.json({ ok: true, data: null });
    }
    const data = JSON.parse(readFileSync(VR_STATE_PATH, 'utf-8'));
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/vr/save
app.post('/api/vr/save', (req, res) => {
  try {
    const state = req.body;
    if (!state) return res.status(400).json({ ok: false, error: 'No body' });

    state.lastUpdated = new Date().toISOString();
    writeFileSync(VR_STATE_PATH, JSON.stringify(state, null, 2));

    // git commit + push
    try {
      execSync('git add financial/vr-state.json', { cwd: ROOT });
      execSync(
        `git commit -m "VR 상태 저장 (${state.ticker || 'unknown'}, V=${state.targetValue || 0})"`,
        { cwd: ROOT }
      );
      execSync('git push', { cwd: ROOT });
      res.json({ ok: true, committed: true });
    } catch (gitErr) {
      // 변경사항 없으면 커밋 실패 가능 — 저장은 성공
      res.json({ ok: true, committed: false, gitMessage: gitErr.message });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== Health ====================

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ==================== Start ====================

app.listen(PORT, () => {
  console.log(`[homi-api] http://localhost:${PORT}`);
});
