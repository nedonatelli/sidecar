// ---------------------------------------------------------------------------
// Keep-best ratchet — Pareto-safe scaffolding (scaffolding roadmap §2.1).
//
// The problem: a scaffold intervention (completion gate, critic, auto-fix) can
// make a run WORSE than it was before the intervention fired. Dogfooding is
// unambiguous — the completion gate reliably drives ~32 KB test-churn patches
// where the bare model stayed ~450 b, and a gate reprompt that demands "write a
// test that exercises this" can turn a passing edit into a failing one when the
// model over-reaches. A scaffold that relies on the *model* to execute extra
// work well is unsafe by design; the keep-best judgment has to live in the
// HARNESS.
//
// The mechanism is a ratchet: snapshot the edited files + the current
// verification signal, let the scaffold drive changes, re-read the signal, and
// KEEP the change only if it did not regress — otherwise REVERT to the
// snapshot. Two ways a change fails the ratchet:
//
//   1. **regression** — a test signal that was green before is no longer green
//      (project tests were passing and now aren't; a per-file passing test
//      dropped out). This is the hard do-no-harm line: scaffolding may never
//      turn a passing run into a failing one.
//
//   2. **over-engineering** — the patch ballooned past a byte threshold WITHOUT
//      improving the pass signal. This is the measurable-at-small-n signal the
//      workstreams tracker calls for (patch minimality), and it's what catches
//      the gate's test-churn behavior even when resolve is noise-dominated.
//
// This module is pure: the signal comparison is a total function of two
// snapshots, and the file snapshot/restore takes INJECTED io (read/write/remove)
// so it is unit-testable now and wires to the real fs — or a shadow/audit-aware
// writer — at the call site without this module knowing which.
// ---------------------------------------------------------------------------

/**
 * Default byte growth past which an unimproved patch is deemed over-engineered.
 *
 * Tightened to 0 (was 4096 / ~4 KB) after a local SWE-bench repro showed the
 * failure mode isn't only large bloat: a 536-byte scaffold-tail edit to an
 * unrelated file (`AutoField.__init__` forced to `blank=True`, nothing to do
 * with the task) slid under the old 4 KB threshold untouched. A byte-size gate
 * can't distinguish "a legitimate small addition" from "a wrong small
 * addition" — so at the default, ANY scaffold-tail growth with no proof it
 * helped (no new passing test/project-test-green) is reverted, not just bloat
 * past a threshold. Raise `overEngineerBytes` (RatchetOptions) if you want to
 * tolerate some unverified growth again — e.g. back to 4096 for the old
 * behavior — but the default now errs toward reverting unproven work.
 */
export const DEFAULT_OVER_ENGINEER_BYTES = 0;

/** The verification signal a ratchet snapshot captures. Sourced from the
 *  gate state the loop already maintains — the ratchet runs NO tests of its
 *  own, it only compares signals the loop already paid for. */
export interface RatchetSignal {
  /** Whether a project-wide test run passed at snapshot time. */
  projectTestsPassed: boolean;
  /** Per-file test files observed passing at snapshot time (copied, not aliased,
   *  so a later mutation of the live gate set can't retroactively change a
   *  captured snapshot). */
  passingTestFiles: ReadonlySet<string>;
  /** Total bytes of the tracked edited files at snapshot time. The
   *  over-engineering guard compares this across before/after. */
  patchBytes: number;
}

export type RatchetVerdict = 'keep' | 'revert-regression' | 'revert-overengineering';

export interface RatchetDecision {
  verdict: RatchetVerdict;
  /** Human-readable reason, for the loop logger and the revert reprompt. */
  reason: string;
}

export interface RatchetOptions {
  /** Byte growth past which an unimproved patch is reverted as over-engineered.
   *  Default 0 — any growth without a proven improvement reverts. Raise this
   *  to tolerate some unverified growth (the pre-tightening default was 4096). */
  overEngineerBytes?: number;
}

/** True when `after` improved the pass signal relative to `before`: project
 *  tests newly green, or a test file that wasn't passing before now is. A patch
 *  that improves the pass signal is never reverted for size — earning a green is
 *  exactly the work scaffolding is meant to provoke. */
function improvedPassSignal(before: RatchetSignal, after: RatchetSignal): boolean {
  if (!before.projectTestsPassed && after.projectTestsPassed) return true;
  for (const f of after.passingTestFiles) {
    if (!before.passingTestFiles.has(f)) return true;
  }
  return false;
}

/**
 * Decide whether a scaffold-driven change should be kept or reverted.
 *
 * Regression dominates: if any green signal went red, revert regardless of
 * size or any new greens (a scaffold that fixes one test while breaking another
 * is not Pareto-safe). Only when nothing regressed do we apply the
 * over-engineering guard.
 */
export function decideRatchet(
  before: RatchetSignal,
  after: RatchetSignal,
  options: RatchetOptions = {},
): RatchetDecision {
  // --- 1. Hard regression: a previously-green signal is no longer green. ---
  if (before.projectTestsPassed && !after.projectTestsPassed) {
    return {
      verdict: 'revert-regression',
      reason: 'project tests were passing before the change and are not after — reverting to the last good state',
    };
  }
  for (const f of before.passingTestFiles) {
    if (!after.passingTestFiles.has(f)) {
      return {
        verdict: 'revert-regression',
        reason: `test ${f} was passing before the change and is no longer confirmed passing — reverting`,
      };
    }
  }

  // --- 2. Over-engineering: unproven growth with no pass-signal improvement.
  // Default threshold is 0 — ANY growth without proof it helped reverts, not
  // just bloat past a byte cap (see DEFAULT_OVER_ENGINEER_BYTES). ---
  const grew = after.patchBytes - before.patchBytes;
  const threshold = options.overEngineerBytes ?? DEFAULT_OVER_ENGINEER_BYTES;
  if (grew > threshold && !improvedPassSignal(before, after)) {
    const bound = threshold > 0 ? ` (over the ${threshold}-byte allowance)` : '';
    return {
      verdict: 'revert-overengineering',
      reason: `change added ${grew} byte${grew === 1 ? '' : 's'} without improving any test signal${bound} — reverting the unproven work`,
    };
  }

  return { verdict: 'keep', reason: 'change held or improved the verification signal' };
}

// --- File snapshot / restore ------------------------------------------------
// A snapshot records the content of a fixed set of paths (null == the file did
// not exist, so restore deletes it). IO is injected so this composes with plain
// fs in production and with a shadow/audit-aware writer when the loop runs in
// those modes — the ratchet never reaches for the filesystem itself.

export interface FileSnapshot {
  /** path → content at snapshot time, or null if the path did not exist. */
  contents: Map<string, string | null>;
}

export interface SnapshotIo {
  /** Return the file's content, or null if it does not exist. Must not throw
   *  for a missing file — return null. */
  read(path: string): Promise<string | null>;
}

export interface RestoreIo {
  write(path: string, content: string): Promise<void>;
  /** Delete a path that did not exist at snapshot time. Must not throw if the
   *  path is already gone. */
  remove(path: string): Promise<void>;
}

/** Capture the current content of every path in `paths`. */
export async function captureFileSnapshot(paths: Iterable<string>, io: SnapshotIo): Promise<FileSnapshot> {
  const contents = new Map<string, string | null>();
  for (const p of paths) {
    contents.set(p, await io.read(p));
  }
  return { contents };
}

/** Total bytes across a set of paths right now (the over-engineering measure).
 *  Missing files count as 0. Uses UTF-8 byte length, not char count, so
 *  multibyte content is measured the way it lands on disk. */
export async function patchBytes(paths: Iterable<string>, io: SnapshotIo): Promise<number> {
  let total = 0;
  for (const p of paths) {
    const c = await io.read(p);
    if (c) total += Buffer.byteLength(c, 'utf-8');
  }
  return total;
}

/**
 * Restore every path in the snapshot to its captured content: rewrite files
 * that had content, delete files that did not exist at snapshot time. Skips a
 * path whose current content already equals the snapshot (no redundant write).
 * Returns the paths that were actually changed back.
 */
export async function restoreFileSnapshot(
  snapshot: FileSnapshot,
  snapIo: SnapshotIo,
  io: RestoreIo,
): Promise<string[]> {
  const reverted: string[] = [];
  for (const [path, original] of snapshot.contents) {
    const current = await snapIo.read(path);
    if (current === original) continue; // already matches — nothing to undo
    if (original === null) {
      await io.remove(path);
    } else {
      await io.write(path, original);
    }
    reverted.push(path);
  }
  return reverted;
}
