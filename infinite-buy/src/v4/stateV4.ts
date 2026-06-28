/**
 * V4.0 전용 상태 관리 — 기존 v2.2/v3.0과 완전 분리된 파일에 저장.
 *  - state/v4-{ticker}.json     : 현재 사이클 상태 (T·mode·평단·보유·5일종가·다음주문)
 *  - history/v4-{ticker}-cycle-NNN.json : 완료 사이클
 *  - logs/v4-{date}.json        : v4 일일 로그
 * 기존 state/{ticker}.json 과 파일명이 겹치지 않으므로 실거래 상태에 영향 없음.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Mode, UniOrder } from './unisheet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 기본은 infinite-buy/ ; 테스트에서 V4_STATE_ROOT 로 임시 디렉토리 격리 가능
const ROOT = process.env.V4_STATE_ROOT || path.resolve(__dirname, '..', '..');

export interface V4State {
  version: 'v4.0';
  ticker: string;
  splitCount: number;
  targetYield: number;
  largeNumPct: number;
  exchange: string;
  cycleNumber: number;
  principal: number;
  mode: Mode;
  tValue: number;
  shares: number;
  avgPrice: number;
  cumProfit: number;          // 사이클 내 누적 실현손익(오늘 제외분 관리)
  recentCloses: number[];     // 직전 종가들 (최근 6개 유지, sma5용)
  nextBuyOrders: UniOrder[];  // 다음 세션에 제출할 매수주문
  nextSellOrders: UniOrder[];
  startedAt: string;
  updatedAt: string;
}

export interface V4History {
  ticker: string; cycleNumber: number; principal: number; endBalance: number;
  profit: number; profitPct: number; finalT: number; startedAt: string; completedAt: string;
}

function readJson<T>(p: string): T | null {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; } catch { return null; }
}
function writeJson(p: string, data: unknown): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function readV4State(ticker: string): V4State | null {
  return readJson<V4State>(path.join(ROOT, 'state', `v4-${ticker}.json`));
}
export function writeV4State(s: V4State): void {
  writeJson(path.join(ROOT, 'state', `v4-${s.ticker}.json`), s);
}
export function appendV4Log(date: string, entry: Record<string, unknown>): void {
  const p = path.join(ROOT, 'logs', `v4-${date}.json`);
  const arr = readJson<unknown[]>(p) || [];
  arr.push(entry);
  writeJson(p, arr);
}
export function saveV4History(h: V4History): void {
  const f = `v4-${h.ticker}-cycle-${String(h.cycleNumber).padStart(3, '0')}.json`;
  writeJson(path.join(ROOT, 'history', f), h);
}
export function nextV4CycleNumber(ticker: string): number {
  const dir = path.join(ROOT, 'history');
  if (!fs.existsSync(dir)) return 1;
  const nums = fs.readdirSync(dir)
    .filter((f: string) => f.startsWith(`v4-${ticker}-cycle-`))
    .map((f: string) => Number(f.match(/cycle-(\d+)/)?.[1] || 0));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/** 초기 사이클 상태 생성 (startCycle 상당) */
export function initV4State(cfg: {
  ticker: string; splitCount: number; targetYield: number; largeNumPct: number;
  exchange: string; principal: number;
}): V4State {
  const now = new Date().toISOString();
  return {
    version: 'v4.0', ticker: cfg.ticker, splitCount: cfg.splitCount, targetYield: cfg.targetYield,
    largeNumPct: cfg.largeNumPct, exchange: cfg.exchange, cycleNumber: nextV4CycleNumber(cfg.ticker),
    principal: cfg.principal, mode: 'NORMAL', tValue: 0, shares: 0, avgPrice: 0, cumProfit: 0,
    recentCloses: [], nextBuyOrders: [], nextSellOrders: [], startedAt: now, updatedAt: now,
  };
}
