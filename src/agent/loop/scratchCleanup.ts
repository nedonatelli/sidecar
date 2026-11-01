import * as path from 'path';
import { Uri, workspace } from 'vscode';
import { GitCLI } from '../../github/git.js';
import { recordDecision } from '../decisions.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Scratch cleanup (#387).
//
// A model that reproduces a bug before fixing it writes `reproduce_issue.py`,
// `verify_fix.py` and the like, and leaves them behind: they land in the
// user's repo next to the fix, pytest collects the `test_*` ones, and in the
// SWE eval they ship in the patch (which is the working tree). At the end of
// a run this moves the scratch files the run created into
// `.sidecar/scratchpad/<run id>/`, which keeps them recoverable.
//
// Most of these files come from the shell (`cat <<EOF > reproduce_issue.py`),
// not from write_file, so "created this run" is what's on disk: the untracked
// set at the end minus the untracked set at the start. Without git, only the
// files write_file created are known (the ratchet's `originals`, null = new).
//
// A created file is scratch when its name or place marks it AND nothing else
// in the change refers to it. A new file in a test directory with an ordinary
// name is kept: it may be the regression test the change needs.
// ---------------------------------------------------------------------------

const SCRATCH_NAME = /^(repro|reproduce|verify|debug|scratch|check_|test_(repro|issue|fix|bug))/i;
const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh)$/i;
/** Files larger than this are never read for the reference check — and a file that big isn't scratch. */
const MAX_SCAN_BYTES = 512 * 1024;
const SCRATCH_DIR = path.posix.join('.sidecar', 'scratchpad');

export interface ScratchRunState {
  enabled: boolean;
  /** Workspace-relative untracked paths at run start; null when the root isn't a git work tree. */
  baselineUntracked: Set<string> | null;
  /** The user's request: a file it names is never moved. */
  userText: string;
}

export function initScratchRunState(enabled: boolean, userText: string): ScratchRunState {
  return { enabled, baselineUntracked: null, userText };
}

/** Whether a created file's name or place marks it as scratch. `rel` is workspace-relative, forward slashes. */
export function isScratchCandidate(rel: string): boolean {
  if (rel.startsWith('.sidecar/')) return false;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (SCRATCH_NAME.test(base)) return true;
  return !rel.includes('/') && SCRIPT_EXT.test(base);
}

/**
 * Of the files the run created, the ones to move. Pure.
 *
 * @param created  workspace-relative paths of files the run created and that still exist
 * @param contents the text of every other file in the change (created or edited), for the reference check
 * @param userText the user's request
 */
export function selectScratchFiles(
  created: readonly string[],
  contents: ReadonlyMap<string, string>,
  userText: string,
): string[] {
  const out: string[] = [];
  for (const rel of created) {
    if (!isScratchCandidate(rel)) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (userText.includes(base)) continue;
    const stem = base.replace(/\.[^.]+$/, '');
    const ref = new RegExp(`(^|[^\\w])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`);
    let referenced = false;
    for (const [other, text] of contents) {
      if (other !== rel && ref.test(text)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) out.push(rel);
  }
  return out;
}

/** Where a moved file goes. */
export function scratchDestination(runId: string, rel: string): string {
  return path.posix.join(SCRATCH_DIR, runId, rel);
}

function untrackedOf(root: string | undefined): Promise<Set<string> | null> {
  // git prints these relative to the root, with forward slashes: the same keys as gateState.editedFiles.
  return new GitCLI(root)
    .listUntracked()
    .then((paths) => new Set(paths))
    .catch(() => null);
}

/** At run start: record which files are already untracked, so a file the run creates can be told apart. */
export async function captureScratchBaseline(state: LoopState, root: string | undefined): Promise<void> {
  const s = state.scratch;
  if (!s?.enabled) return;
  s.baselineUntracked = await untrackedOf(root);
}

/** Files the run created that still exist, workspace-relative. */
async function createdThisRun(state: LoopState, s: ScratchRunState, root: string | undefined): Promise<string[]> {
  if (s.baselineUntracked) {
    const now = await untrackedOf(root);
    if (now) return [...now].filter((p) => !s.baselineUntracked!.has(p)).sort();
  }
  const out: string[] = [];
  for (const [p, original] of state.ratchet?.originals ?? []) {
    if (original === null && (await exists(uriFor(root, p)))) out.push(p);
  }
  return out.sort();
}

function uriFor(root: string | undefined, rel: string): Uri {
  if (path.isAbsolute(rel)) return Uri.file(rel);
  const rootUri = root ? Uri.file(root) : workspace.workspaceFolders?.[0]?.uri;
  return rootUri ? Uri.joinPath(rootUri, rel) : Uri.file(rel);
}

async function exists(uri: Uri): Promise<boolean> {
  try {
    await workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readSmall(uri: Uri): Promise<string | null> {
  try {
    const stat = await workspace.fs.stat(uri);
    if (stat.size > MAX_SCAN_BYTES) return null;
    return Buffer.from(await workspace.fs.readFile(uri)).toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * At the end of a run: move the scratch files it created into
 * `.sidecar/scratchpad/<run id>/` and say so. Best-effort: a failure is logged
 * and the files stay where they are.
 */
export async function cleanupScratchAtTermination(
  state: LoopState,
  root: string | undefined,
  callbacks: AgentCallbacks,
): Promise<void> {
  const s = state.scratch;
  if (!s?.enabled) return;
  try {
    const created = await createdThisRun(state, s, root);
    if (!created.some(isScratchCandidate)) return;
    const contents = new Map<string, string>();
    for (const rel of new Set([...created, ...state.gateState.editedFiles])) {
      const text = await readSmall(uriFor(root, rel));
      if (text !== null) contents.set(rel, text);
    }
    const scratch = selectScratchFiles(created, contents, s.userText);
    if (scratch.length === 0) return;

    // The run's folder ignores itself, so the moved files stay out of git
    // status and the patch whether or not this workspace has a .sidecar/.gitignore.
    const runDir = uriFor(root, path.posix.join(SCRATCH_DIR, state.runId));
    await workspace.fs.createDirectory(runDir);
    await workspace.fs.writeFile(Uri.joinPath(runDir, '.gitignore'), Buffer.from('*\n', 'utf-8'));
    const moved: string[] = [];
    for (const rel of scratch) {
      try {
        const dest = scratchDestination(state.runId, rel);
        await workspace.fs.createDirectory(uriFor(root, path.posix.dirname(dest)));
        await workspace.fs.rename(uriFor(root, rel), uriFor(root, dest), { overwrite: true });
        moved.push(rel);
      } catch (err) {
        state.logger?.warn(
          `Scratch cleanup: could not move ${rel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (moved.length === 0) return;
    const dir = path.posix.join(SCRATCH_DIR, state.runId);
    recordDecision(
      state.logger,
      { kind: 'scratch_cleanup', action: 'moved', files: moved.map((p) => ({ path: p })) },
      `Scratch cleanup: moved ${moved.length} file(s) the run created to ${dir}: ${moved.join(', ')}`,
    );
    callbacks.onText(
      `\n\n🧹 Moved ${moved.length} scratch file(s) this run created out of the workspace, to \`${dir}/\`: ` +
        `${moved.join(', ')}\n`,
    );
  } catch (err) {
    state.logger?.warn(`Scratch cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
