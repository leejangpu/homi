// 상태 파일 로드/저장. state/ddsaopal-<SYMBOL>.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, CycleState } from "./types.js";
import { initState } from "./calculator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "state");

function statePath(symbol: string): string {
  return join(STATE_DIR, `ddsaopal-${symbol}.json`);
}

export function loadState(cfg: Config): CycleState {
  const p = statePath(cfg.symbol);
  if (!existsSync(p)) return initState(cfg);
  const s = JSON.parse(readFileSync(p, "utf8")) as CycleState;
  // 하위호환 필드 보정
  s.plannedOrders ??= [];
  s.submittedOrders ??= [];
  return s;
}

export function saveState(state: CycleState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(state.symbol), JSON.stringify(state, null, 2) + "\n");
}
