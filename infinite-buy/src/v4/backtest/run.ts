/**
 * V4.0 실데이터 백테스트 실행기
 * 실행: npx tsx src/v4/backtest/run.ts [TQQQ|SOXL] [logDays]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, type OHLC, type SimConfig } from './simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');

const DATAFILE = (process.argv[2] || 'TQQQ');               // data/<DATAFILE>.json
const LOG_DAYS = Number(process.argv[3] || 25);
const TICKER = DATAFILE.startsWith('SOXL') ? 'SOXL' : 'TQQQ';

const ohlc: OHLC[] = JSON.parse(fs.readFileSync(path.join(DATA, `${DATAFILE}.json`), 'utf-8'));

const cfg: SimConfig = {
  ticker: TICKER,
  splitCount: 40,
  principal: 10000,
  targetYield: TICKER === 'SOXL' ? 20 : 15,
  largeNumPct: 10,
};

const res = runBacktest(cfg, ohlc);

console.log(`\n===== ${TICKER} 40분할 백테스트 (원금 $${cfg.principal}, 목표 ${cfg.targetYield}%, 큰수 ${cfg.largeNumPct}%) =====`);
console.log(`기간 ${ohlc[0].date} ~ ${ohlc[ohlc.length - 1].date} (${ohlc.length}일)`);
console.log(`최종 잔금(평가 제외): $${res.finalBalance.toFixed(2)}  | 완료 사이클: ${res.cycles.length}개`);

console.log(`\n[완료 사이클]`);
for (const c of res.cycles) {
  console.log(`  ${c.endDate}: 원금 $${c.startPrincipal.toFixed(2)} → $${c.endBalance.toFixed(2)} (${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%) 최종T ${c.finalT.toFixed(2)}`);
}

console.log(`\n[처음 ${LOG_DAYS}일 로그]`);
console.log('날짜       | 모드   | 종가   | 평단   | 보유 | T값   | P%     | 잔금     | 매수주문 / 매도주문');
for (const r of res.records.slice(0, LOG_DAYS)) {
  console.log(
    `${r.date} | ${r.mode.padEnd(6)} | ${r.close.toFixed(2).padStart(6)} | ${r.avg.toFixed(2).padStart(6)} | ${String(r.shares).padStart(4)} | ${r.T.toFixed(2).padStart(5)} | ${r.P.toFixed(2).padStart(5)} | ${r.balance.toFixed(0).padStart(7)} | ${r.buy}  ▷  ${r.sell}`
  );
}

// 모드 분포 + 무결성 체크
const modeCount: Record<string, number> = {};
let negCash = 0, oversold = 0;
for (const r of res.records) {
  modeCount[r.mode] = (modeCount[r.mode] || 0) + 1;
  if (r.balance < -1) negCash++;
  if (r.shares < 0) oversold++;
}
console.log(`\n[무결성] 모드분포=${JSON.stringify(modeCount)}  음수잔금=${negCash}  음수보유=${oversold}`);
