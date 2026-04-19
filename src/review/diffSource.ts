import { exec } from 'child_process';
import { promisify } from 'util';

// ---------------------------------------------------------------------------
// Diff source primitive (v0.68 chunk 1).
//
// Pre-v0.68, `src/review/prSummary.ts` and `src/review/reviewer.ts`
// both contained a copy of the same ~20-line block:
//
//   1. `git diff HEAD` → if empty, `git diff --cached` → if still
//      empty, bail with an info toast.
//   2. Cap at 30_000 chars with a `(diff truncated)` marker.
//   3. Use 2 MB maxBuffer for the exec call.
//
// Chunks 2–4 of v0.68 (Draft PR From Branch, Branch Protection,
// CI Failure Analysis) need diff sources too — notably the
// branch-range variant (`git diff <base>...HEAD`) for PR bodies.
// This module consolidates the pattern before a third copy lands.
//
// The primitive is intentionally VS Code-free. Existing callers
// keep ownership of the "show warning on empty / on error" UX —
// they read `isEmpty` / `error` on the result and decide whether
// to toast, bail silently, or proceed with whatever else they
// planned. The primitive just runs git and normalizes the output.
// ---------------------------------------------------------------------------

const execAsync = promisify(exec);

/** Default buffer cap for `git diff` stdout (2 MB matches the historical callers). */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Default character cap on the returned diff string (30k matches the historical callers). */
const DEFAULT_TRUNCATE_CHARS = 30_000;

export interface FetchDiffOptions {
  /** Absolute path to the git working tree. Caller must verify non-empty before calling. */
  readonly cwd: string;
  /**
   * Max bytes the underlying `exec` buffer will hold before rejecting.
   * Defaults to 2 MB, matching the historical prSummary/reviewer behavior.
   */
  readonly maxBytes?: number;
  /**
   * Post-fetch character cap. Diffs larger than this get sliced to the
   * first N chars with a `\n... (diff truncated)` marker appended.
   * Defaults to 30 000, matching the historical callers.
   */
  readonly truncateChars?: number;
}

export type DiffSource = 'working' | 'staged' | 'range' | 'none';

export interface FetchDiffResult {
  /** Raw (or truncated) diff text. Empty string when `isEmpty` is true. */
  readonly diff: string;
  /** `true` when every attempted source returned empty stdout. */
  readonly isEmpty: boolean;
  /** `true` when `diff` was sliced to fit `truncateChars`. */
  readonly wasTruncated: boolean;
  /**
   * Which source produced the returned diff. `'none'` when `isEmpty`
   * is true; `'working'` / `'staged'` for workingTree-or-staged
   * fallback; `'range'` for branch-range fetches.
   */
  readonly source: DiffSource;
  /**
   * Human-readable error message when the underlying `git diff`
   * invocation failed (e.g. not a git repo, permission denied,
   * over-maxBuffer). Mutually exclusive with `diff` / `isEmpty`:
   * when `error` is set, callers should surface it instead of
   * treating the result as a successful empty diff.
   */
  readonly error?: string;
}

/**
 * Fetch the working-tree diff against `HEAD`, falling back to the
 * staged diff (`git diff --cached`) when the working tree is clean.
 *
 * This is what the existing `summarizePR` and `reviewCurrentChanges`
 * commands do today — keep fidelity with that behavior so the chunk 1
 * migration is a no-op semantically.
 */
export async function fetchWorkingTreeDiff(options: FetchDiffOptions): Promise<FetchDiffResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncateChars = options.truncateChars ?? DEFAULT_TRUNCATE_CHARS;
  const execOpts = { cwd: options.cwd, maxBuffer: maxBytes };

  try {
    const { stdout: working } = await execAsync('git diff HEAD', execOpts);
    if (working.trim().length > 0) {
      return buildResult(working, 'working', truncateChars);
    }
  } catch (err) {
    return { diff: '', isEmpty: true, wasTruncated: false, source: 'none', error: formatError(err) };
  }

  try {
    const { stdout: staged } = await execAsync('git diff --cached', execOpts);
    if (staged.trim().length > 0) {
      return buildResult(staged, 'staged', truncateChars);
    }
  } catch (err) {
    return { diff: '', isEmpty: true, wasTruncated: false, source: 'none', error: formatError(err) };
  }

  return { diff: '', isEmpty: true, wasTruncated: false, source: 'none' };
}

/**
 * Fetch the branch-range diff — `git diff <base>...HEAD` by default,
 * or `git diff <base>...<head>` if `head` is provided. Used by the
 * Draft PR From Branch flow (v0.68 chunk 2) to generate a PR body
 * from the commits between the branch's divergence point and its
 * current tip.
 *
 * Callers typically resolve `base` via `git merge-base origin/main HEAD`
 * or by reading the upstream-tracking ref — that resolution lives in
 * the caller, not here, so this primitive stays a pure git-wrapper.
 */
export async function fetchBranchRangeDiff(
  base: string,
  options: FetchDiffOptions & { head?: string },
): Promise<FetchDiffResult> {
  if (!base || !base.trim()) {
    return { diff: '', isEmpty: true, wasTruncated: false, source: 'none', error: 'base is required' };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncateChars = options.truncateChars ?? DEFAULT_TRUNCATE_CHARS;
  const execOpts = { cwd: options.cwd, maxBuffer: maxBytes };
  const head = options.head && options.head.trim().length > 0 ? options.head : 'HEAD';
  const cmd = `git diff ${shellSafeRef(base)}...${shellSafeRef(head)}`;

  try {
    const { stdout } = await execAsync(cmd, execOpts);
    if (stdout.trim().length === 0) {
      return { diff: '', isEmpty: true, wasTruncated: false, source: 'none' };
    }
    return buildResult(stdout, 'range', truncateChars);
  } catch (err) {
    return { diff: '', isEmpty: true, wasTruncated: false, source: 'none', error: formatError(err) };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildResult(raw: string, source: DiffSource, truncateChars: number): FetchDiffResult {
  if (raw.length > truncateChars) {
    return {
      diff: raw.slice(0, truncateChars) + '\n... (diff truncated)',
      isEmpty: false,
      wasTruncated: true,
      source,
    };
  }
  return { diff: raw, isEmpty: false, wasTruncated: false, source };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Allow only characters that git refs can contain. Prevents shell
 * metacharacters in a caller-supplied ref from escaping the `git diff`
 * invocation — we build the command as a string (for exec), so
 * accepting arbitrary ref names would be an injection vector. Refs
 * that fail this check are substituted with an empty string so the
 * `git diff` command fails with a clear "ambiguous argument" error
 * rather than silently running a different command.
 */
function shellSafeRef(ref: string): string {
  // Whitelist — allow the character set git ref names actually need:
  //   - alphanumeric
  //   - / _ . - :      (branch path components, namespace colons)
  //   - @ { }          (reflog selectors: HEAD@{1}, @{upstream})
  //   - ~ ^            (range selectors: HEAD~1, origin/main^)
  // Reject anything else (shell metacharacters `;` `&` `|` `$` backticks
  // `"` `'` spaces newlines, etc.) so a caller-supplied ref can't escape
  // the `git diff` invocation. Non-conforming refs substitute to '' so
  // git fails cleanly with "ambiguous argument" rather than running a
  // different command.
  if (!/^[a-zA-Z0-9/_.\-:@~^{}]+$/.test(ref)) return '';
  return ref;
}
