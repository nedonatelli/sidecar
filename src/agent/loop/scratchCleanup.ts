import * as path from 'path';
import { FileType, Uri, workspace } from 'vscode';
import { GitCLI } from '../../github/git.js';
import { recordDecision } from '../decisions.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import { changedFiles, fileToolName } from '../tools/toolOutcome.js';
import { resolveToolNameAlias } from '../executor/toolNameAlias.js';

// ---------------------------------------------------------------------------
// Scratch cleanup (#387, narrowed by #418).
//
// A model that reproduces a bug before fixing it writes `reproduce_issue.py`,
// `verify_fix.py` and the like, and leaves them behind: they land in the
// user's repo next to the fix, pytest collects the `test_*` ones, and in the
// SWE eval they ship in the patch (which is the working tree). At the end of
// a run this moves the scratch files the run created into
// `.sidecar/scratchpad/<run id>/`, which keeps them recoverable.
//
// "Created by this run" needs two things (#418):
// - on disk, the file is new: untracked at the end and not at the start
//   (without git, the ratchet's `originals` entry is null);
// - this run's own tools made it: a write_file / edit_file outcome names it
//   (ADR-008), or one of this run's run_command commands names it. Most
//   scratch comes from the shell (`cat <<EOF > reproduce_issue.py`, then
//   `python reproduce_issue.py`), and git can't say who wrote an untracked
//   file, so a command that names the file stands in for "the shell wrote
//   it". A file the user or a background agent created during the run is not
//   named by any of this run's calls, so it stays.
//
// A created file is scratch when its name marks it AND nothing else in the
// change refers to it AND the user's message doesn't name it:
// - only script extensions;
// - `repro`, `reproduce`, `scratch`, `test_(repro|issue|fix|bug)` followed by
//   `[_.-]` or the extension, anywhere;
// - `verify`, `debug`, `check`, `compare`, `test` followed the same way, only
//   at the workspace root (`auth/verify_token.py` is a module), and not when a
//   root file with the same prefix was already there (the project keeps such
//   files at its root);
// - never under a test directory, where a new file may be the regression test
//   the change needs; never under `.sidecar/`.
// There is no rule for other root scripts: `convert.py`, `jest.config.js`,
// `conftest.py` and `setup.py` look the same as a throwaway script.
// ---------------------------------------------------------------------------

const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh)$/i;
/** Scratch-marking prefixes valid anywhere outside a test directory. Matched against the stem. */
const SCRATCH_ANYWHERE = /^(repro|reproduce|scratch|test_(repro|issue|fix|bug))([_.-]|$)/i;
/** Prefixes that mark scratch only at the workspace root. Matched against the stem. */
const SCRATCH_AT_ROOT = /^(verify|debug|check|compare|test)([_.-]|$)/i;
/** A directory segment that holds tests. */
const TEST_DIR = /^(tests?|__tests__|testing|specs?|e2e)$|^tests?[_-]|[_-]tests?$/i;
/** Files larger than this are never read for the reference check — and a file that big isn't scratch. */
const MAX_SCAN_BYTES = 512 * 1024;
const SCRATCH_DIR = path.posix.join('.sidecar', 'scratchpad');

export interface ScratchRunState {
  enabled: boolean;
  /** Workspace-relative untracked paths at run start; null when the root isn't a git work tree. */
  baselineUntracked: Set<string> | null;
  /** The user's request: a file it names is never moved. */
  userText: string;
  /** Paths this run's write_file / edit_file calls changed (ADR-008 outcomes), forward slashes. */
  written: Set<string>;
  /** The commands this run's run_command calls ran. */
  commands: string[];
}

export function initScratchRunState(enabled: boolean, userText: string): ScratchRunState {
  return { enabled, baselineUntracked: null, userText, written: new Set(), commands: [] };
}

/**
 * After a batch of tool calls: remember what this run's own tools wrote and
 * ran, so cleanup only considers files they made (#418).
 */
export function noteScratchToolCalls(state: LoopState, toolUses: readonly ToolUseContentBlock[]): void {
  const s = state.scratch;
  if (!s?.enabled) return;
  for (const tu of toolUses) {
    const tool = fileToolName(tu.name);
    if (tool === 'write_file' || tool === 'edit_file') {
      for (const p of changedFiles(state.toolOutcomes.get(tu.id))) s.written.add(p);
    } else if ((resolveToolNameAlias(tu.name) ?? tu.name) === 'run_command') {
      const command = tu.input?.command;
      if (typeof command === 'string') s.commands.push(command);
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether this run's own tools made `rel`: a file tool wrote it, or a command names it. Pure. */
export function madeByRun(rel: string, written: ReadonlySet<string>, commands: readonly string[]): boolean {
  for (const w of written) {
    if (w === rel || w.endsWith(`/${rel}`)) return true;
  }
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const named = new RegExp(`(^|[^\\w.-])${escapeRe(base)}($|[^\\w.-])`);
  return commands.some((c) => named.test(c));
}

/** Whether a created file's name and place mark it as scratch. `rel` is workspace-relative, forward slashes. */
export function isScratchCandidate(rel: string): boolean {
  if (rel.startsWith('.sidecar/')) return false;
  const parts = rel.split('/');
  const base = parts.pop() ?? '';
  if (!SCRIPT_EXT.test(base)) return false;
  if (parts.some((d) => TEST_DIR.test(d))) return false;
  const stem = base.replace(SCRIPT_EXT, '');
  if (SCRATCH_ANYWHERE.test(stem)) return true;
  return parts.length === 0 && SCRATCH_AT_ROOT.test(stem);
}

/** The root-only prefix a file name starts with, lower-cased, or null. */
function rootPrefix(base: string): string | null {
  const m = SCRATCH_AT_ROOT.exec(base.replace(SCRIPT_EXT, ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Of the files the run created, the ones to move. Pure.
 *
 * @param created   workspace-relative paths of files the run created and that still exist
 * @param contents  the text of every other file in the change (created or edited), for the reference check
 * @param userText  the user's request
 * @param rootFiles names of the files at the workspace root that the run did not create
 */
export function selectScratchFiles(
  created: readonly string[],
  contents: ReadonlyMap<string, string>,
  userText: string,
  rootFiles: readonly string[] = [],
): string[] {
  const rootHas = new Set(rootFiles.filter((b) => SCRIPT_EXT.test(b)).map(rootPrefix));
  const out: string[] = [];
  for (const rel of created) {
    if (!isScratchCandidate(rel)) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (userText.includes(base)) continue;
    const stem = base.replace(/\.[^.]+$/, '');
    // A root-only prefix the project already uses at its root (`test_app.py` next to `app.py`).
    if (!rel.includes('/') && !SCRATCH_ANYWHERE.test(stem) && rootHas.has(rootPrefix(base))) continue;
    const ref = new RegExp(`(^|[^\\w])${escapeRe(stem)}([^\\w]|$)`);
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
  const ours = (p: string) => madeByRun(p, s.written, s.commands);
  if (s.baselineUntracked) {
    const now = await untrackedOf(root);
    if (now) return [...now].filter((p) => !s.baselineUntracked!.has(p) && ours(p)).sort();
  }
  const out: string[] = [];
  for (const [p, original] of state.ratchet?.originals ?? []) {
    if (original === null && ours(p) && (await exists(uriFor(root, p)))) out.push(p);
  }
  return out.sort();
}

/** Names of the files at the workspace root, minus the ones the run created. */
async function rootFilesBefore(root: string | undefined, created: readonly string[]): Promise<string[]> {
  const mine = new Set(created.filter((p) => !p.includes('/')));
  try {
    const entries = await workspace.fs.readDirectory(uriFor(root, '.'));
    return entries.filter(([name, type]) => type === FileType.File && !mine.has(name)).map(([name]) => name);
  } catch {
    return [];
  }
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
    const scratch = selectScratchFiles(created, contents, s.userText, await rootFilesBefore(root, created));
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
