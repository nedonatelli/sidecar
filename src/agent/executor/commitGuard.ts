import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import { shellCommandOf } from './irrecoverableDetector.js';
import { gitEnvForCwd } from '../loop/treeSignature.js';

/**
 * Look at what a commit would contain before the agent makes it.
 *
 * In one autonomous run the agent copied two gitignored folders (its own
 * `.sidecar/logs` and `.sidecar/cache`) into a new tracked folder, committed
 * the copy -- 757 files, 70.7 MB -- and pushed it. `.gitignore` matches paths,
 * so a copy under a new name is an ordinary untracked file, and nothing looked
 * at the commit's size either. Its longest path was 255 characters, which a
 * Windows clone without `core.longpaths` cannot check out.
 *
 * A commit is held for the user's approval, in every mode, when it would:
 *  - hold a file `.gitignore` matches: one staged with `git add -f`, or one
 *    committed before the ignore rule existed (git keeps tracking it);
 *  - come from a command that force-adds (`git add -f`), whose files are not
 *    staged yet when this looks;
 *  - add copies of gitignored files (same content as a file git ignores);
 *  - be larger than COMMIT_LIMITS.totalBytes, or hold a file larger than
 *    COMMIT_LIMITS.fileBytes;
 *  - add more than COMMIT_LIMITS.newFiles files;
 *  - hold a path longer than COMMIT_LIMITS.pathChars.
 * An ordinary source change passes all of these, so it adds no prompts.
 *
 * Unlike detectConfigEdit this runs git, so it runs only for a commit. Any git
 * failure returns null and leaves the commit to fail or succeed by itself.
 */

export const COMMIT_LIMITS = {
  totalBytes: 10 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  newFiles: 500,
  // Repository-relative. Windows' limit is 260 for the whole path, and a clone
  // under `C:\Users\<name>\Documents\<repo>\` spends about 40 of those.
  pathChars: 200,
};

/** Ignored trees that hold dependencies, never the user's own data; not searched for copies. */
const DEPENDENCY_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.gradle',
  'target',
  '.git',
]);

/** At most this many ignored files are size-checked for copies. */
const MAX_IGNORED_SCAN = 20_000;

export interface CommitCall {
  via: 'git_commit' | 'command';
  /**
   * The command stages files itself (`git add`, `commit -a`), so the commit
   * holds more than the index does now: untracked and modified files count too.
   */
  addsFiles: boolean;
  /** The command runs `git add -f` / `--force`, which stages files .gitignore excludes. */
  forceAdds: boolean;
}

const SHELL_COMMIT_RE = /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/;
const SHELL_ADD_RE = /\bgit\s+(?:-[Cc]\s+\S+\s+)*add\b/;
const FORCE_ADD_RE = /\bgit\s+(?:-[Cc]\s+\S+\s+)*add\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/;
const COMMIT_ALL_RE = /\bcommit\b[^;&|\n]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b/;

/** A tool call that makes a git commit, or null. */
export function commitCallOf(toolUse: ToolUseContentBlock): CommitCall | null {
  if (toolUse.name === 'git_commit') return { via: 'git_commit', addsFiles: false, forceAdds: false };
  const cmd = shellCommandOf(toolUse);
  if (!cmd || !SHELL_COMMIT_RE.test(cmd)) return null;
  return {
    via: 'command',
    addsFiles: SHELL_ADD_RE.test(cmd) || COMMIT_ALL_RE.test(cmd),
    forceAdds: FORCE_ADD_RE.test(cmd),
  };
}

export interface CommitReview {
  /** One line per problem, for the approval and for the refusal. */
  concerns: string[];
}

interface Candidate {
  path: string;
  bytes: number;
  isNew: boolean;
  /** Blob id of the content that would be committed, when known. */
  sha?: string;
}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: gitEnvForCwd(), maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const nul = (s: string) => s.split('\0').filter(Boolean);

/** What the commit would hold: staged additions and changes, plus the work tree when the command stages it. */
async function candidates(root: string, addsFiles: boolean): Promise<Candidate[]> {
  // :<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0
  const raw = nul(
    await git(root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--diff-filter=AM', '--abbrev=40']),
  );
  const staged: Candidate[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const fields = raw[i].split(' ');
    staged.push({ path: raw[i + 1], bytes: 0, isNew: fields[4] === 'A', sha: fields[3] });
  }
  if (staged.length > 0) {
    const sizes = (
      await git(root, ['cat-file', '--batch-check=%(objectsize)'], staged.map((c) => c.sha).join('\n') + '\n')
    )
      .split('\n')
      .filter(Boolean);
    staged.forEach((c, i) => (c.bytes = Number(sizes[i]) || 0));
  }
  if (!addsFiles) return staged;
  const seen = new Set(staged.map((c) => c.path));
  const untracked = nul(await git(root, ['ls-files', '-z', '-o', '--exclude-standard']));
  const modified = nul(await git(root, ['ls-files', '-z', '-m']));
  const more: Candidate[] = [];
  for (const [list, isNew] of [
    [untracked, true],
    [modified, false],
  ] as const) {
    for (const p of list) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const st = fs.statSync(path.join(root, p));
        if (st.isFile()) more.push({ path: p, bytes: st.size, isNew });
      } catch {
        // deleted since the listing: nothing to commit
      }
    }
  }
  return [...staged, ...more];
}

/** Every file under `dir`, skipping dependency trees, up to `limit`. */
function walk(root: string, dir: string, out: string[], limit: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!DEPENDENCY_DIRS.has(e.name)) walk(root, rel, out, limit);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

/** The new candidates whose content equals a gitignored file's, with that file's top folder. */
async function ignoredCopies(root: string, fresh: Candidate[]): Promise<Map<string, string[]>> {
  const bySize = new Map<number, Candidate[]>();
  for (const c of fresh) if (c.bytes > 0) bySize.set(c.bytes, [...(bySize.get(c.bytes) ?? []), c]);
  if (bySize.size === 0) return new Map();
  // --directory lists an ignored folder once instead of every file in it.
  const listed = nul(await git(root, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory']));
  const ignoredFiles: string[] = [];
  for (const entry of listed) {
    if (ignoredFiles.length >= MAX_IGNORED_SCAN) break;
    const rel = entry.replace(/\/$/, '');
    if (rel.split('/').some((seg) => DEPENDENCY_DIRS.has(seg))) continue;
    if (entry.endsWith('/')) walk(root, rel, ignoredFiles, MAX_IGNORED_SCAN);
    else ignoredFiles.push(rel);
  }
  const sameSize = ignoredFiles.filter((p) => {
    try {
      return bySize.has(fs.statSync(path.join(root, p)).size);
    } catch {
      return false;
    }
  });
  if (sameSize.length === 0) return new Map();
  const needSha = fresh.filter((c) => !c.sha && bySize.has(c.bytes));
  if (needSha.length > 0) {
    const shas = (await git(root, ['hash-object', '--stdin-paths'], needSha.map((c) => c.path).join('\n') + '\n'))
      .split('\n')
      .filter(Boolean);
    needSha.forEach((c, i) => (c.sha = shas[i]));
  }
  const ignoredShas = (await git(root, ['hash-object', '--stdin-paths'], sameSize.join('\n') + '\n'))
    .split('\n')
    .filter(Boolean);
  const origin = new Map<string, string>();
  sameSize.forEach((p, i) => {
    if (ignoredShas[i] && !origin.has(ignoredShas[i])) origin.set(ignoredShas[i], p);
  });
  // Grouped by the ignored file's folder, which is what the user recognises.
  const copies = new Map<string, string[]>();
  for (const c of fresh) {
    const src = c.sha ? origin.get(c.sha) : undefined;
    if (!src) continue;
    const folder = path.posix.dirname(src);
    copies.set(folder, [...(copies.get(folder) ?? []), c.path]);
  }
  return copies;
}

/**
 * The candidates whose own path `.gitignore` matches. `git add` refuses an
 * ignored path unless forced, so these were force-added or were tracked before
 * the rule. --no-index checks the rules alone; a tracked file would otherwise
 * never be reported. Exit 1 means "none matched".
 */
function ignoredPaths(root: string, files: Candidate[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['check-ignore', '--no-index', '-z', '--stdin'],
      { cwd: root, env: gitEnvForCwd(), maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => {
        if (!err) resolve(nul(stdout));
        else if ((err as { code?: unknown }).code === 1) resolve([]);
        else reject(err);
      },
    );
    child.stdin?.end(files.map((f) => f.path).join('\0') + '\0');
  });
}

function sample(paths: string[]): string {
  return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ', …' : '');
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The problems with the commit `call` would make in `cwd`, or null when there are none (or git cannot say). */
export async function reviewCommit(call: CommitCall, cwd: string): Promise<CommitReview | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (!root) return null;
    const files = await candidates(root, call.addsFiles);
    const concerns: string[] = [];
    if (call.forceAdds) {
      concerns.push(
        'The command force-adds files (git add -f), which stages files .gitignore keeps out of the repository.',
      );
    }
    if (files.length === 0) return concerns.length > 0 ? { concerns } : null;

    const ignored = new Set(await ignoredPaths(root, files));
    if (ignored.size > 0) {
      const added = files.filter((f) => f.isNew && ignored.has(f.path)).map((f) => f.path);
      const tracked = files.filter((f) => !f.isNew && ignored.has(f.path)).map((f) => f.path);
      if (added.length > 0) {
        concerns.push(
          `${added.length} new file${added.length === 1 ? '' : 's'} that .gitignore excludes (${sample(added)}): ` +
            'staged with git add -f.',
        );
      }
      if (tracked.length > 0) {
        concerns.push(
          `${tracked.length} changed file${tracked.length === 1 ? '' : 's'} that .gitignore now excludes ` +
            `(${sample(tracked)}): git still tracks ${tracked.length === 1 ? 'it' : 'them'} because ` +
            `${tracked.length === 1 ? 'it was' : 'they were'} committed before the rule. ` +
            '`git rm --cached <path>` stops tracking without deleting the file.',
        );
      }
    }

    const fresh = files.filter((f) => f.isNew);
    const copies = await ignoredCopies(root, fresh);
    if (copies.size > 0) {
      const n = [...copies.values()].reduce((s, v) => s + v.length, 0);
      const folders = [...copies.keys()].slice(0, 3).join(', ') + (copies.size > 3 ? ', …' : '');
      concerns.push(
        `${n} of the new files are copies of files git ignores (from ${folders}). ` +
          '.gitignore keeps those out of the repository; a copy under a new path is not ignored.',
      );
    }

    const total = files.reduce((s, f) => s + f.bytes, 0);
    const largest = files.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    if (total > COMMIT_LIMITS.totalBytes || largest.bytes > COMMIT_LIMITS.fileBytes) {
      concerns.push(
        `Size: ${mb(total)} in ${files.length} files; the largest is ${largest.path} (${mb(largest.bytes)}). ` +
          'Once pushed, it stays in every clone\u2019s history.',
      );
    }

    if (fresh.length > COMMIT_LIMITS.newFiles) {
      concerns.push(`Files: ${fresh.length} new files in one commit.`);
    }

    const long = files.filter((f) => f.path.length > COMMIT_LIMITS.pathChars);
    if (long.length > 0) {
      const longest = long.reduce((a, b) => (b.path.length > a.path.length ? b : a));
      concerns.push(
        `Paths: ${long.length} longer than ${COMMIT_LIMITS.pathChars} characters (longest ${longest.path.length}). ` +
          'A Windows clone without core.longpaths cannot check them out.',
      );
    }
    return concerns.length > 0 ? { concerns } : null;
  } catch {
    return null;
  }
}

/** The approval question. */
export function commitReviewQuestion(review: CommitReview): string {
  return `SideCar wants to make a commit that needs a look first:\n${review.concerns.map((c) => `- ${c}`).join('\n')}`;
}

/** What the agent is told when the commit did not happen. */
export function commitReviewRefusal(review: CommitReview, askedUser: boolean): string {
  const who = askedUser
    ? 'The user declined this commit.'
    : 'The commit was not made: this run has no one to ask, and a commit like this needs the user\u2019s approval.';
  return (
    `${who} ${review.concerns.join(' ')} ` +
    'Do not commit these files another way, and do not push. Leave them uncommitted, and say in your answer ' +
    'what you would have committed and why, so the user can decide.'
  );
}
