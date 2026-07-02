import * as path from 'path';
import { Uri, workspace } from 'vscode';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import {
  decideRatchet,
  captureFileSnapshot,
  restoreFileSnapshot,
  patchBytes,
  type RatchetSignal,
  type SnapshotIo,
  type RestoreIo,
} from './keepBestRatchet.js';

// ---------------------------------------------------------------------------
// Keep-best ratchet — loop wiring (scaffolding roadmap §2.1).
//
// This is the harness half of the keep-best judgment: it brackets the
// scaffold-driven tail of a run so a completion-gate / critic reprompt can
// never turn a good run into a worse one. Three touch points in runAgentLoop:
//
//   1. `captureRatchetOriginals` — BEFORE each tool dispatch, snapshot the
//      pre-edit content of every file a write tool is about to touch (only the
//      first time each path is seen). This is the true pre-run baseline, so a
//      file created during the scaffold tail can be deleted on revert and a
//      pre-existing file restored to its original bytes.
//
//   2. `captureScaffoldBoundary` — the FIRST time scaffolding drives extra
//      work (a completion-gate empty-response reprompt fires) with edits
//      already on disk, snapshot the current verification signal + the content
//      of the already-edited "good" files. Everything the model does after
//      this point is scaffold-driven and subject to the ratchet.
//
//   3. `evaluateRatchetAtTermination` — at natural completion, compare the
//      end-state signal to the boundary signal via `decideRatchet`. On a
//      revert verdict, restore the pre-scaffold files to their boundary
//      content and undo the scaffold-tail files (delete if created this run,
//      restore original otherwise), then tell the user.
//
// The pure decision + snapshot primitives live in `keepBestRatchet.ts`. The
// only VS Code coupling here is the workspace.fs IO, which honors `cwdOverride`
// (so it writes into a Shadow Workspace worktree or the campaign's mounted
// root, not the user's tree). Audit mode buffers writes in memory rather than
// on disk, so the ratchet is disabled there (see runAgentLoop wiring).
// ---------------------------------------------------------------------------

/** Tools whose target file the ratchet must baseline before dispatch. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'delete_file']);

/** Per-run ratchet state carried on LoopState. */
export interface RatchetRunState {
  enabled: boolean;
  overEngineerBytes: number;
  /** path → pre-run original content (null = did not exist at first write). */
  originals: Map<string, string | null>;
  boundaryCaptured: boolean;
  boundarySignal: RatchetSignal | null;
  /** Pre-scaffold edited files → their content at the boundary (the good state). */
  boundaryContent: Map<string, string | null>;
  preScaffoldFiles: Set<string>;
}

export function initRatchetRunState(enabled: boolean, overEngineerBytes: number): RatchetRunState {
  return {
    enabled,
    overEngineerBytes,
    originals: new Map(),
    boundaryCaptured: false,
    boundarySignal: null,
    boundaryContent: new Map(),
    preScaffoldFiles: new Set(),
  };
}

/** Extract the file paths a batch of tool calls is about to write/edit/delete. */
export function writeTargetsFromToolUses(uses: readonly ToolUseContentBlock[]): string[] {
  const out: string[] = [];
  for (const u of uses) {
    if (!WRITE_TOOL_NAMES.has(u.name)) continue;
    const p = (u.input as { path?: unknown } | undefined)?.path;
    if (typeof p === 'string' && p.length > 0) out.push(p);
  }
  return out;
}

/**
 * Choose the restore target for every finally-edited file when the ratchet
 * decides to revert. Pure — the caller applies the result via RestoreIo.
 *
 *   - pre-scaffold file  → its boundary content (keep the good work, undo the
 *     scaffold-tail churn layered on top). Skipped if we somehow lack it.
 *   - scaffold-tail file → its pre-run original (null ⇒ delete a file created
 *     this run). A tail file we never baselined is SKIPPED, never deleted —
 *     the ratchet must not risk removing a pre-existing file it can't prove
 *     was created during the run.
 */
export function selectRevertContents(
  finalEditedFiles: ReadonlySet<string>,
  preScaffoldFiles: ReadonlySet<string>,
  boundaryContent: ReadonlyMap<string, string | null>,
  originals: ReadonlyMap<string, string | null>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const f of finalEditedFiles) {
    if (preScaffoldFiles.has(f)) {
      if (boundaryContent.has(f)) out.set(f, boundaryContent.get(f) ?? null);
    } else if (originals.has(f)) {
      out.set(f, originals.get(f) ?? null);
    }
  }
  return out;
}

/** Build the ratchet's verification signal from the gate state the loop
 *  already maintains, plus the live byte size of the edited-file set. */
async function signalFromGate(state: LoopState, io: SnapshotIo): Promise<RatchetSignal> {
  return {
    projectTestsPassed: state.gateState.projectTestsPassed,
    passingTestFiles: new Set(state.gateState.passingTestFiles),
    patchBytes: await patchBytes(state.gateState.editedFiles, io),
  };
}

/** A workspace.fs-backed IO rooted at the loop's effective working directory
 *  (cwdOverride when set → Shadow Workspace / mounted campaign root). Absolute
 *  paths are honored as-is so an edited-file entry stored absolute still
 *  resolves. */
export function makeWorkspaceRatchetIo(rootDir: string | undefined): SnapshotIo & RestoreIo {
  const rootUri = rootDir ? Uri.file(rootDir) : workspace.workspaceFolders?.[0]?.uri;
  const uriFor = (p: string): Uri =>
    path.isAbsolute(p) ? Uri.file(p) : rootUri ? Uri.joinPath(rootUri, p) : Uri.file(p);
  return {
    async read(p: string): Promise<string | null> {
      try {
        const bytes = await workspace.fs.readFile(uriFor(p));
        return Buffer.from(bytes).toString('utf-8');
      } catch {
        return null;
      }
    },
    async write(p: string, content: string): Promise<void> {
      await workspace.fs.writeFile(uriFor(p), Buffer.from(content, 'utf-8'));
    },
    async remove(p: string): Promise<void> {
      try {
        await workspace.fs.delete(uriFor(p), { useTrash: true });
      } catch {
        /* already gone — nothing to undo */
      }
    },
  };
}

/** Snapshot the pre-edit content of every write target in this turn's tool
 *  batch, once per path. No-op when the ratchet is off. */
export async function captureRatchetOriginals(
  state: LoopState,
  pendingToolUses: readonly ToolUseContentBlock[],
  io: SnapshotIo,
): Promise<void> {
  const r = state.ratchet;
  if (!r?.enabled) return;
  for (const p of writeTargetsFromToolUses(pendingToolUses)) {
    if (!r.originals.has(p)) r.originals.set(p, await io.read(p));
  }
}

/** Arm the ratchet at the first scaffold intervention that occurs with edits
 *  already present. No-op when off, already armed, or nothing has been edited
 *  yet (so a pure review/no-grounding reprompt never arms a file revert). */
export async function captureScaffoldBoundary(state: LoopState, io: SnapshotIo): Promise<void> {
  const r = state.ratchet;
  if (!r?.enabled || r.boundaryCaptured || state.gateState.editedFiles.size === 0) return;
  r.boundaryCaptured = true;
  r.preScaffoldFiles = new Set(state.gateState.editedFiles);
  r.boundarySignal = await signalFromGate(state, io);
  const snap = await captureFileSnapshot(state.gateState.editedFiles, io);
  r.boundaryContent = snap.contents;
  state.logger?.info(
    `Keep-best ratchet armed at scaffold boundary — ${r.preScaffoldFiles.size} pre-scaffold file(s), ` +
      `${r.boundarySignal.patchBytes}b, projectTestsPassed=${r.boundarySignal.projectTestsPassed}`,
  );
}

/**
 * At natural termination, decide whether the scaffold-driven tail should be
 * kept or reverted, and apply the revert. No-op when the ratchet never armed
 * (scaffolding never drove extra work). Best-effort: any IO failure is logged
 * and swallowed so the ratchet can never break a completed run.
 */
export async function evaluateRatchetAtTermination(
  state: LoopState,
  io: SnapshotIo & RestoreIo,
  callbacks: AgentCallbacks,
): Promise<void> {
  const r = state.ratchet;
  if (!r?.enabled || !r.boundaryCaptured || !r.boundarySignal) return;
  try {
    const after = await signalFromGate(state, io);
    const decision = decideRatchet(r.boundarySignal, after, { overEngineerBytes: r.overEngineerBytes });
    if (decision.verdict === 'keep') {
      state.logger?.info(`Keep-best ratchet: kept — ${decision.reason}`);
      return;
    }
    const targets = selectRevertContents(
      state.gateState.editedFiles,
      r.preScaffoldFiles,
      r.boundaryContent,
      r.originals,
    );
    const reverted = await restoreFileSnapshot({ contents: targets }, io, io);
    if (reverted.length === 0) {
      state.logger?.info(`Keep-best ratchet: ${decision.verdict} but nothing to revert (files already at target)`);
      return;
    }
    state.logger?.warn(
      `Keep-best ratchet: ${decision.verdict} — reverted ${reverted.length} file(s). ${decision.reason}`,
    );
    const kind = decision.verdict === 'revert-regression' ? 'a test regression' : 'over-engineering (patch bloat)';
    callbacks.onText(
      `\n\n♻️ Keep-best ratchet reverted scaffold-driven changes to ${reverted.length} file(s) — ` +
        `${kind}. ${decision.reason}\n   Reverted: ${reverted.join(', ')}\n`,
    );
  } catch (err) {
    state.logger?.warn(`Keep-best ratchet skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
