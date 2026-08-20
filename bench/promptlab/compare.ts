import * as fs from 'fs';
import { compareArms, scored, trialsNeeded, type ArmResult, type TrialOutcome } from './guards.js';
import { assertComparable, type RunManifest, type Axis } from './manifest.js';

// ---------------------------------------------------------------------------
// Read recorded runs, group them into arms, and report only what the numbers
// support.
//
// The comparison API this uses was written, tested, and then had no caller: for
// an entire evening the way to compare two arms was to hand-write a throwaway
// vitest file, read the output, and delete it. That ritual is why differences of
// one or two trials kept being read as signal — nothing made the significance
// test the default path.
// ---------------------------------------------------------------------------

interface TrajectoryRecord {
  caseId: string;
  model: string;
  passed: boolean;
  apiUnavailable?: boolean;
  durationMs?: number;
  iterationsUsed?: number;
  configOverrides?: Record<string, unknown>;
  surface?: {
    systemPromptChars: number;
    systemPromptHash: string;
    toolNames: string[];
    toolCatalogHash: string;
    ragOrientationChars: number;
    seed: number | null;
    temperature: number;
    numCtx: number | null;
  };
}

export function readRecords(jsonlPath: string): TrajectoryRecord[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const out: TrajectoryRecord[] = [];
  for (const line of fs.readFileSync(jsonlPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TrajectoryRecord);
    } catch {
      /* a truncated tail line is normal for a run killed mid-write */
    }
  }
  return out;
}

/**
 * Name an arm by what it RAN, not by a label someone typed.
 *
 * A label is a claim; a hash is a fact. Two runs that disagree on the prompt or
 * catalog are different arms even when both were called "bare".
 */
export function armKey(r: TrajectoryRecord): string {
  const s = r.surface;
  if (!s) return 'unrecorded-surface';
  return [
    `sys:${s.systemPromptHash}`,
    `tools:${s.toolCatalogHash}`,
    `rag:${s.ragOrientationChars > 0 ? 'on' : 'off'}`,
  ].join(' ');
}

export function toManifest(r: TrajectoryRecord, cases: string[], trials: number): RunManifest | null {
  const s = r.surface;
  if (!s) return null;
  return {
    model: r.model,
    seed: s.seed,
    temperature: s.temperature,
    numCtx: s.numCtx,
    cases,
    trials,
    caseTimeoutMs: 0,
    systemPromptMode: `${s.systemPromptChars}c`,
    toolTier: `${s.toolNames.length} tools`,
    ragOrientation: s.ragOrientationChars > 0,
    configOverrides: r.configOverrides ?? {},
    systemPromptHash: s.systemPromptHash,
    toolCatalogHash: s.toolCatalogHash,
    createdAt: '',
  };
}

const outcome = (r: TrajectoryRecord): TrialOutcome => (r.apiUnavailable ? 'TIMEOUT' : r.passed ? 'PASS' : 'FAIL');

export function buildArms(records: TrajectoryRecord[], caseId?: string): Map<string, ArmResult> {
  const arms = new Map<string, ArmResult>();
  for (const r of records) {
    if (caseId && r.caseId !== caseId) continue;
    const key = armKey(r);
    const arm = arms.get(key) ?? { arm: key, outcomes: [], expectedTrials: 0 };
    arm.outcomes.push(outcome(r));
    // Recorded runs are all we have: expected == recorded unless a caller says
    // otherwise, so `valid` here reflects "this is what ran", not a promise.
    arm.expectedTrials = arm.outcomes.length;
    arms.set(key, arm);
  }
  return arms;
}

export function render(records: TrajectoryRecord[], caseId?: string, expectedTrials?: number): string {
  const lines: string[] = [];
  const arms = buildArms(records, caseId);
  if (arms.size === 0) return 'No records matched.';

  lines.push(caseId ? `# ${caseId}` : '# all cases');
  const unrecorded = records.filter((r) => !r.surface).length;
  if (unrecorded > 0) {
    lines.push(
      `\n⚠️  ${unrecorded} record(s) predate surface recording and are grouped as ` +
        `"unrecorded-surface" — they cannot be attributed to an arm.`,
    );
  }

  lines.push('\n## Arms');
  for (const [key, arm] of arms) {
    if (expectedTrials) arm.expectedTrials = expectedTrials;
    const s = scored(arm);
    lines.push(
      `  ${s.passed}/${s.scored}${s.timeouts ? ` (+${s.timeouts} timeout)` : ''}` +
        `${s.valid ? '' : '  ⚠️ INCOMPLETE — fewer trials than requested'}   ${key}`,
    );
  }

  const keys = [...arms.keys()];
  if (keys.length > 1) {
    lines.push('\n## Comparisons');
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        lines.push(`  ${compareArms(arms.get(keys[i])!, arms.get(keys[j])!).summary}`);
      }
    }
  }

  // Say what it would take to resolve what we could not, rather than leaving an
  // INCONCLUSIVE verdict looking like a dead end.
  const rates = keys.map((k) => {
    const s = scored(arms.get(k)!);
    return s.scored ? s.passed / s.scored : 0;
  });
  if (rates.length > 1) {
    const [hi, lo] = [Math.max(...rates), Math.min(...rates)];
    if (hi !== lo)
      lines.push(`\n  trials/arm needed to resolve ${hi.toFixed(2)} vs ${lo.toFixed(2)}: ${trialsNeeded(hi, lo)}`);
  }
  return lines.join('\n');
}

/** Compare the manifests of two records and report whether they may be compared. */
export function checkComparable(
  a: TrajectoryRecord,
  b: TrajectoryRecord,
  axes: Axis[],
  cases: string[],
  trials: number,
): string {
  const ma = toManifest(a, cases, trials);
  const mb = toManifest(b, cases, trials);
  if (!ma || !mb) return 'cannot verify: one or both records predate surface recording';
  const v = assertComparable(ma, mb, axes);
  return [
    v.comparable ? 'comparable' : `NOT comparable: ${v.unexpectedDiffs.join('; ')}`,
    ...v.warnings.map((w) => `warning: ${w}`),
  ].join('\n');
}
