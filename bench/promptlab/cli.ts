#!/usr/bin/env node
import { readRecords, render } from './compare.js';

// `npm run promptlab -- [--case <id>] [--trials <n>] [--file <path>]`
//
// Exists so the significance test is the DEFAULT path rather than something
// reached by hand-writing a throwaway vitest file — which is how one- and
// two-trial differences kept getting read as signal.

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const file =
  flag('file') ?? `${process.env.SIDECAR_EVAL_TRAJECTORY_DIR || '.sidecar/logs/eval-trajectories'}/trajectories.jsonl`;
const caseId = flag('case');
const trials = flag('trials') ? Number(flag('trials')) : undefined;

const records = readRecords(file);
if (records.length === 0) {
  console.error(`No records in ${file}. Run an eval first, or pass --file.`);
  process.exit(1);
}

if (!caseId) {
  const cases = [...new Set(records.map((r) => r.caseId))];
  console.log(`${records.length} records across ${cases.length} case(s) in ${file}\n`);
  for (const c of cases) console.log(render(records, c, trials) + '\n');
} else {
  console.log(render(records, caseId, trials));
}
