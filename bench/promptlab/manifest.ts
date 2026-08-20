import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Run manifests: what a comparison is allowed to claim.
//
// Two arms are comparable only when their configurations differ in exactly the
// field under test. That sounds obvious and was violated repeatedly: a 60-char
// change to one tool's DESCRIPTION — a tool the model never called — flipped an
// arm from correct to 8 errors and a wrong-target edit, deterministically. The
// baseline had moved and nothing said so, so the difference was attributed to
// the variable under test.
//
// Hashing the prompt surface makes that mechanical instead of remembered.
// ---------------------------------------------------------------------------

export interface RunManifest {
  model: string;
  /** Unseeded runs cannot support trial-level comparison; recorded, not assumed. */
  seed: number | null;
  temperature: number;
  numCtx: number | null;
  cases: string[];
  trials: number;
  caseTimeoutMs: number;
  /** The ablation axes. */
  systemPromptMode: string;
  toolTier: string;
  ragOrientation: boolean;
  configOverrides: Record<string, unknown>;
  /** Hashes of the actual bytes sent, not a description of them. */
  systemPromptHash: string;
  toolCatalogHash: string;
  createdAt: string;
}

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Fields that may differ between two arms of one comparison. */
export type Axis = keyof Pick<
  RunManifest,
  'systemPromptMode' | 'toolTier' | 'ragOrientation' | 'configOverrides' | 'systemPromptHash' | 'toolCatalogHash'
>;

/**
 * Everything that must be IDENTICAL for two arms to be compared. Anything not
 * listed as an intended axis and not equal here invalidates the comparison.
 */
const INVARIANTS: (keyof RunManifest)[] = [
  'model',
  'seed',
  'temperature',
  'numCtx',
  'cases',
  'trials',
  'caseTimeoutMs',
];

export interface ComparabilityVerdict {
  comparable: boolean;
  /** Fields that differ but were not declared as the axis under test. */
  unexpectedDiffs: string[];
  warnings: string[];
}

export function assertComparable(a: RunManifest, b: RunManifest, intendedAxes: Axis[]): ComparabilityVerdict {
  const unexpectedDiffs: string[] = [];
  const warnings: string[] = [];

  for (const k of INVARIANTS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      unexpectedDiffs.push(`${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
  }

  // A surface hash may differ ONLY because an intended axis moved it. Changing
  // the tool text while testing the system prompt is the failure this catches.
  const surfaceAxes: Axis[] = ['systemPromptHash', 'toolCatalogHash'];
  for (const k of surfaceAxes) {
    if (a[k] === b[k]) continue;
    const explained =
      (k === 'systemPromptHash' && intendedAxes.includes('systemPromptMode')) ||
      (k === 'toolCatalogHash' && intendedAxes.includes('toolTier'));
    if (!explained) unexpectedDiffs.push(`${k} changed but no axis explains it: ${a[k]} vs ${b[k]}`);
  }

  if (a.seed === null || b.seed === null) {
    warnings.push('unseeded run — trial-level comparison is not meaningful; treat small gaps as noise');
  }
  if (a.temperature > 0 && a.seed === null) {
    warnings.push(`temperature ${a.temperature} without a seed — repeat runs of the SAME config will disagree`);
  }

  return { comparable: unexpectedDiffs.length === 0, unexpectedDiffs, warnings };
}
