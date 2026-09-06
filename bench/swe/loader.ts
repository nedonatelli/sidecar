// ---------------------------------------------------------------------------
// SWE-bench Lite loading + deterministic sampling.
//
// The dataset ships on HuggingFace (SWE-bench/SWE-bench_Lite). Export it
// to JSON or JSONL and point the loader at it. We normalize the upstream field
// names (FAIL_TO_PASS / PASS_TO_PASS arrive as JSON-encoded strings) into SweTask.
// ---------------------------------------------------------------------------

import type { SweTask } from './types.js';

interface UpstreamRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  // Upstream encodes these as JSON strings OR arrays depending on the export.
  FAIL_TO_PASS?: string | string[];
  PASS_TO_PASS?: string | string[];
  patch?: string;
  version?: string;
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function normalize(row: UpstreamRow): SweTask {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    fail_to_pass: asList(row.FAIL_TO_PASS),
    pass_to_pass: asList(row.PASS_TO_PASS),
    ...(row.patch ? { patch: row.patch } : {}),
    ...(row.version ? { version: row.version } : {}),
  };
}

/** Parse a JSON array OR newline-delimited JSON (JSONL) of upstream rows. */
export function parseTasks(raw: string): SweTask[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return (JSON.parse(trimmed) as UpstreamRow[]).map(normalize);
  }
  const tasks: SweTask[] = [];
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    tasks.push(normalize(JSON.parse(line) as UpstreamRow));
  }
  return tasks;
}

/**
 * Deterministically sample `n` tasks. Sorting by instance_id first makes the
 * slice reproducible across runs and machines — the same `n` always yields the
 * same task set, which the reproducibility envelope requires. Pass a `repos`
 * filter to scope to a subset of projects (useful when only some repo images
 * are built locally).
 */
export function sampleTasks(tasks: SweTask[], n: number, repos?: string[]): SweTask[] {
  let pool = tasks;
  if (repos && repos.length > 0) {
    const set = new Set(repos);
    pool = pool.filter((t) => set.has(t.repo));
  }
  const sorted = [...pool].sort((a, b) => (a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0));
  return sorted.slice(0, n);
}
