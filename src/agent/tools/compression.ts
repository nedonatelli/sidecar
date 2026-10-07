// Pure text-compression helpers for tool output. Shaped after the
// rtk-ai filter model (group / truncate / dedup), implemented natively
// so SideCar doesn't need an external binary. Keeping these as pure
// functions lets the tests hit them directly without spinning up the
// tool runtime or mocking child_process.
//
// Each helper takes the raw tool output and returns a smaller string
// that preserves the information the agent actually reasons about.
// "Smaller" means fewer tokens for the model, not necessarily fewer
// bytes — the emphasis is on removing repetition and noise rather than
// clever packing.

/**
 * Compress raw `grep -rn` output by grouping matches under each file
 * header once, instead of repeating the filename on every match line.
 * Also truncates individual match bodies to a sensible width and
 * collapses runs of identical match lines with a `(×N)` suffix.
 *
 * Input format expected: `path:line:content` per line (grep -rn style).
 * Unrecognized lines are passed through unchanged so we never silently
 * drop information.
 *
 * Typical savings: 40–60% on results that span many files with long
 * lines, because each file's path is written once and long lines get
 * clipped to the keyword neighborhood.
 */
export function compressGrepOutput(raw: string, maxLineWidth = 140): string {
  if (!raw) return raw;

  const lines = raw.split('\n');
  const byFile = new Map<string, string[]>();
  const passthrough: string[] = [];
  const fileOrder: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    // grep -rn output is `path:line:content`, but binary warnings and
    // summary lines don't match that shape. Preserve them as-is.
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) {
      passthrough.push(line);
      continue;
    }
    const [, filePath, lineNum, content] = match;
    if (!byFile.has(filePath)) {
      byFile.set(filePath, []);
      fileOrder.push(filePath);
    }
    const body = truncateMiddle(content.trim(), maxLineWidth);
    byFile.get(filePath)!.push(`  ${lineNum}: ${body}`);
  }

  if (byFile.size === 0) return raw;

  const out: string[] = [];
  for (const filePath of fileOrder) {
    const entries = byFile.get(filePath)!;
    out.push(filePath);
    // Collapse consecutive identical match bodies with a (×N) counter
    // so 50-matches-of-the-same-import-line don't bloat the response.
    let i = 0;
    while (i < entries.length) {
      let runEnd = i + 1;
      const currentBody = stripLeadingLineNum(entries[i]);
      while (runEnd < entries.length && stripLeadingLineNum(entries[runEnd]) === currentBody) {
        runEnd++;
      }
      const runLen = runEnd - i;
      if (runLen > 1) {
        out.push(`${entries[i]}  (×${runLen})`);
      } else {
        out.push(entries[i]);
      }
      i = runEnd;
    }
  }

  for (const p of passthrough) out.push(p);

  return out.join('\n');
}

function stripLeadingLineNum(entry: string): string {
  // "  45: content" → "content"
  const match = /^\s*\d+:\s?(.*)$/.exec(entry);
  return match ? match[1] : entry;
}

/**
 * Truncate a string in the middle, preserving head and tail, when it
 * exceeds `max` chars. Middle ellipsis beats tail truncation for grep
 * results because the keyword is often in the middle of a long line
 * (import paths, assignments, JSX attributes).
 */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 3) / 2);
  return s.slice(0, keep) + '...' + s.slice(s.length - keep);
}

/**
 * Strip low-signal lines from `git diff` output: the `index 0abc..1def`
 * blob hashes and the `diff --git a/foo b/foo` preamble (redundant with
 * the `--- a/foo` / `+++ b/foo` lines that follow). Also collapses runs
 * of >2 context lines inside a hunk to a single `…` marker when we can
 * do it safely (i.e. they're not adjacent to a change).
 *
 * Conservative by design — we don't touch the actual +/- change lines,
 * only redundant headers and unchanged context padding. That keeps the
 * agent's ability to reason about the diff intact.
 */
export function compressGitDiff(raw: string): string {
  if (!raw) return raw;
  const lines = raw.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    // Drop blob hashes — agents never need them.
    if (/^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/.test(line)) continue;
    // Drop the redundant `diff --git a/x b/x` preamble; the `--- a/x`
    // and `+++ b/x` pair right below it already names the file.
    if (/^diff --git a\/.+ b\/.+/.test(line)) continue;
    // Drop `new file mode`, `deleted file mode`, `similarity index`,
    // `rename from/to` — useful for humans reviewing a PR, noise for
    // the model. The file header (`--- /dev/null` vs `+++ b/foo`)
    // already carries the new/deleted bit.
    if (/^(new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode) /.test(line)) {
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

/** Which comment syntaxes a file's language actually has, by extension. */
function commentSyntax(filePath: string): { block: boolean; slash: boolean; hash: boolean } {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  const cFamily = new Set([
    'ts',
    'tsx',
    'mts',
    'cts',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'c',
    'h',
    'cc',
    'cpp',
    'cxx',
    'hpp',
    'hh',
    'cs',
    'java',
    'go',
    'rs',
    'swift',
    'kt',
    'kts',
    'scala',
    'php',
    'dart',
    'groovy',
    'scss',
    'less',
  ]);
  const hash = new Set(['py', 'pyw', 'rb', 'sh', 'bash', 'zsh', 'fish', 'toml', 'yaml', 'yml', 'r', 'pl', 'pm', 'ps1']);
  if (cFamily.has(ext)) return { block: true, slash: true, hash: false };
  if (ext === 'css') return { block: true, slash: false, hash: false };
  if (hash.has(ext)) return { block: false, slash: false, hash: true };
  return { block: false, slash: false, hash: false };
}

/**
 * Remove `/* … *\/` comments that are really comments: a `/*` inside a string
 * literal or after `//` on the same line is text. The old regex took the
 * first `/*` anywhere, so `"src/*.ts"` swallowed everything up to the next
 * `*\/` -- real code gone from what the model was shown.
 */
function stripBlockComments(text: string, filePath: string, slashComments: boolean): string {
  const rust = /\.rs$/i.test(filePath);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (slashComments && c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    // In Rust a lone ' opens a lifetime (`'a`), not a literal; only a
    // complete char literal ('x', '\n') is a quoted span.
    const quoted = c === '"' || c === '`' || (c === "'" && (!rust || /^'(?:\\.|[^\\'\n])'/.test(text.slice(i, i + 4))));
    if (quoted) {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Remove comment blocks and collapse whitespace runs from a source
 * file to produce a "compact" reading mode. Aims at the biggest
 * free-lunch savings without touching executable code, so this is
 * safer than signature-only mode for round-tripping through edits
 * that target code (not comments).
 *
 * Strips only the comment syntax the file's language has (by extension):
 *   - /\* ... *\/ block comments (including JSDoc) in C-family files and CSS,
 *     outside string literals
 *   - `// ...` full-line comments in C-family files (inline `// ...` at the
 *     end of a line is preserved — it may explain a tricky expression)
 *   - `# ...` full-line comments in Python, Ruby, shell, TOML, YAML…, keeping
 *     `#!` shebangs. In C (`#include`), Rust (`#[derive]`) or CSS (`#id`) a
 *     `#` line is code, and dropping it everywhere deleted those.
 *   - Trailing whitespace, and runs of >2 blank lines collapsed to 1, in any file
 *
 * Does NOT strip inline comments or JSX; the cost of getting
 * language-specific parsing wrong exceeds the token win.
 */
export function compactSourceFile(text: string, filePath = ''): string {
  if (!text) return text;
  const syntax = commentSyntax(filePath);
  const compact = syntax.block ? stripBlockComments(text, filePath, syntax.slash) : text;

  const lines = compact.split('\n');
  const kept: string[] = [];
  let blankRun = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const leading = trimmed.match(/^\s*/)?.[0] ?? '';
    const body = trimmed.slice(leading.length);
    // Full-line C-style comment (// ...): drop.
    if (syntax.slash && body.startsWith('//')) continue;
    // Full-line hash comment: drop — but keep `#!` shebangs since losing
    // them changes file semantics.
    if (syntax.hash && body.startsWith('#') && !body.startsWith('#!')) continue;

    if (trimmed.length === 0) {
      blankRun++;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    kept.push(trimmed);
  }

  return kept.join('\n');
}

/**
 * Extract an outline of a source file: imports, class / function /
 * interface / type declarations — anything that looks like a
 * top-level signature. Bodies are dropped. Aims at big files where
 * the agent needs to know "what's in here" without needing the full
 * implementation.
 *
 * Heuristic by design — a regex pass that recognizes common
 * TypeScript / JavaScript / Python / Go / Rust declaration forms.
 * For anything the regex doesn't match, we fall back to the file's
 * first ~40 lines so the model at least sees the header + imports.
 */
export function outlineSourceFile(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  // Only match lines with NO leading indentation — top-level declarations
  // only. Nested `const`/`let`/`function` inside a function body or class
  // method should not appear in the outline; the user can read the file
  // in full mode if they need the internals.
  const declRegex =
    /^(export\s+(?:default\s+)?(?:async\s+)?)?(import\s|from\s|use\s|package\s|module\s|class\s|interface\s|type\s|enum\s|struct\s|impl\s|trait\s|fn\s|func\s|def\s|function\s|const\s|let\s|var\s|public\s|private\s|protected\s)/;
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (declRegex.test(line)) {
      // Keep signature only — strip trailing `{` body start.
      kept.push(line.replace(/\{\s*$/, '').trimEnd());
    }
  }
  if (kept.length === 0) {
    return lines.slice(0, 40).join('\n') + (lines.length > 40 ? '\n... (outline heuristic matched nothing)' : '');
  }
  return kept.join('\n');
}
