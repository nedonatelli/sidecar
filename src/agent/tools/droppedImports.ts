// Refuse an edit that removes a Python import whose name the file still uses (#334).
//
// In the recorded SWE canaries (gemma4:e4b, 2026-10-20 to 10-25), 66 of 1,500
// submitted patches removed an import that the file went on using, and they
// were 15% of the runs that broke existing tests. The module then fails at
// import time and takes every test that imports it along: scikit-learn-10949
// replaced `import numpy as np` with `import pandas as pd` while `np` appeared
// 74 more times, and 42 passing tests broke; django-11583 dropped
// `from pathlib import Path` in 28 runs, breaking 23-24 tests each time.
//
// This compares the import bindings of the whole file before and after the
// edit, so it sees what the edit did to the file, not only to its own snippet.

const PY_FILE = /\.pyi?$/i;
const IMPORT_START = /^\s*(?:from\s+[\w.]+\s+import\b|import\s+[\w.])/;

export interface DroppedImport {
  /** The name the removed import bound. */
  name: string;
  /** The removed import statement, as one line. */
  importLine: string;
  /** 1-based line in the new file that still uses the name, and its text. */
  useLine: number;
  useText: string;
}

/** Import statements, each joined onto one line (parenthesised and backslash-continued forms included). */
function importStatements(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORT_START.test(lines[i])) continue;
    let stmt = lines[i];
    const open = () => (stmt.match(/\(/g)?.length ?? 0) > (stmt.match(/\)/g)?.length ?? 0) || /\\\s*$/.test(stmt);
    while (open() && i + 1 < lines.length) stmt = `${stmt.replace(/\\\s*$/, '')} ${lines[++i].trim()}`;
    out.push(stmt.replace(/#.*$/, '').trim());
  }
  return out;
}

/** name -> the import statement that binds it. `*` records a star import. */
function importBindings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of importStatements(text)) {
    const from = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(stmt);
    if (from) {
      if (from[1] === '__future__') continue;
      for (const part of from[2].replace(/[()]/g, '').split(',')) {
        const p = part.trim();
        if (p === '*') out.set('*', stmt);
        else if (p)
          out.set(
            p
              .split(/\s+as\s+/)
              .pop()!
              .trim(),
            stmt,
          );
      }
      continue;
    }
    const imp = /^import\s+(.+)$/.exec(stmt);
    if (!imp) continue;
    for (const part of imp[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      out.set(
        /\s+as\s+/.test(p)
          ? p
              .split(/\s+as\s+/)
              .pop()!
              .trim()
          : p.split('.')[0],
        stmt,
      );
    }
  }
  return out;
}

/** True when `name` is bound in `text` some way other than an import. */
function boundOtherwise(text: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    [
      `^\\s*(?:async\\s+)?def\\s+${n}\\b`,
      `^\\s*class\\s+${n}\\b`,
      `^\\s*${n}\\s*(?::[^=\\n]+)?=(?!=)`, // assignment, annotated or not
      `^\\s*for\\s+(?:[\\w\\s,]*\\b)?${n}\\b[\\w\\s,]*\\bin\\b`,
      `\\bas\\s+${n}\\s*[:,)]`, // with ... as name: / except E as name:
      `^\\s*global\\s+.*\\b${n}\\b`,
    ].join('|'),
    'm',
  ).test(text);
}

/** A line with its comment and single-line string literals removed, so a mention there is not a use. */
function codeOnly(line: string): string {
  return line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, '');
}

/**
 * Imports the edit removed (bound before, not after) whose name the new file
 * still references and binds no other way. Empty for non-Python files, and when
 * the new file has a star import (it may supply the name).
 */
export function droppedUsedImports(filePath: string, before: string, after: string): DroppedImport[] {
  if (!PY_FILE.test(filePath)) return [];
  const was = importBindings(before);
  const now = importBindings(after);
  if (now.has('*')) return [];
  const out: DroppedImport[] = [];
  const lines = after.split(/\r\n|\r|\n/);
  for (const [name, stmt] of was) {
    if (name === '*' || now.has(name) || boundOtherwise(after, name)) continue;
    const use = new RegExp(`(?<![\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (IMPORT_START.test(lines[i])) continue;
      if (use.test(codeOnly(lines[i]))) {
        out.push({ name, importLine: stmt, useLine: i + 1, useText: lines[i].trim() });
        break;
      }
    }
  }
  return out;
}

/**
 * The refusal for a non-empty {@link droppedUsedImports} result. `repeat` is how
 * many times in a row this exact call has been refused (1 = first). In the #336
 * canary a refused edit was resubmitted unchanged 8 times, each getting the same
 * answer, before the model rewrote the whole file around the guard; a repeat now
 * says so and names the way forward.
 */
export function droppedImportError(
  filePath: string,
  dropped: DroppedImport[],
  opts: { tool?: 'edit_file' | 'write_file'; repeat?: number } = {},
): string {
  const tool = opts.tool ?? 'edit_file';
  const d = dropped[0];
  const more =
    dropped.length > 1
      ? ` (and ${dropped.length - 1} more: ${dropped
          .slice(1)
          .map((x) => `\`${x.name}\``)
          .join(', ')})`
      : '';
  const field = tool === 'edit_file' ? "'replace'" : 'the content';
  const repeat =
    (opts.repeat ?? 1) > 1
      ? ` This is the same call refused ${opts.repeat} times in a row — sending it again will be refused again. ` +
        `Change it: keep \`${d.importLine}\`, or first remove every use of \`${d.name}\`.`
      : '';
  return (
    `Error: ${tool} refused this ${tool === 'edit_file' ? 'edit' : 'write'} to ${filePath} — it removes ` +
    `\`${d.importLine}\`, but \`${d.name}\` is still used${more} (line ${d.useLine}: \`${d.useText.slice(0, 120)}\`). ` +
    `The file was NOT modified. Keep that import in ${field} — put any new import on a line of its own — or remove ` +
    `every use of \`${d.name}\` as well.${repeat}`
  );
}
