import * as fs from 'fs';
import * as path from 'path';

// File names the user's request mentions, for the no-read and no-file-write
// gates (#317). A request that is an issue report quotes files that are not in
// the workspace at all: a `pip list` row (`aspy.yaml`), a traceback frame
// (`File "/some/path/django/contrib/admin/utils.py"`), a shell command
// (`$ ./manage.py help tzkt_import`), the reporter's own module
// (`pmxbot/logging.py`). Demanding a read or write of those sent the model to
// files that do not exist, and it took the demand as a new instruction from the
// user (2026-10-21 canary: no-read fired in 6 of 18 no-source runs, no-file-write
// in 7; `pytest-7490`: "The user is instructing me to read the file aspy.yaml").

/** A file name in prose: a path segment ending in a source/config extension. */
export const FILE_MENTION_RE =
  /\b[\w./\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|toml|yaml|yml|sh|cs|java|cpp|c|h)\b/gi;

export interface Mention {
  file: string;
  index: number;
}

/** Every file mention in `text`, with its position. */
export function fileMentions(text: string): Mention[] {
  return [...text.matchAll(new RegExp(FILE_MENTION_RE.source, 'gi'))].map((m) => ({ file: m[0], index: m.index ?? 0 }));
}

/**
 * True when the mention at `index` is QUOTED material, not something the
 * request asks about: inside a fenced code block, on an indented code line, on
 * a shell (`$ `) or REPL (`>>> `) line, on a traceback frame line, or the tail
 * of an absolute path the mention pattern cut short (the `\b` at its start
 * skips a leading `/`, `\` or drive colon).
 */
export function isQuotedMention(text: string, index: number): boolean {
  const before = text.slice(0, index);
  if ((before.match(/```/g) ?? []).length % 2 === 1) return true;
  const prev = index > 0 ? text[index - 1] : '';
  if (prev === '/' || prev === '\\' || prev === ':') return true;
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart, text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index));
  if (/^(?:\t| {4})/.test(line)) return true;
  if (/^\s*(?:\$|>>>|\.\.\.)\s/.test(line)) return true;
  if (/^\s*File "/.test(line)) return true;
  return false;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', 'dist', 'build']);
const WALK_LIMIT = 20_000;

/**
 * Does `file` exist in the workspace under `root`? A path is checked as given;
 * a bare name (`views.py`) is looked for anywhere, the way a user means it
 * ("fix views.py" for `app/views.py`). The walk is bounded; past the bound the
 * answer is `true`, so a huge workspace keeps today's behaviour.
 */
export function existsInWorkspace(root: string, file: string): boolean {
  const clean = file.replace(/[`'"]/g, '').replace(/^\.\//, '');
  if (fs.existsSync(path.join(root, clean))) return true;
  if (clean.includes('/') || clean.includes('\\')) return false;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) return true;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else if (e.name === clean) {
        return true;
      }
    }
  }
  return false;
}
