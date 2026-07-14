import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsNode from 'fs';
import * as pathNode from 'path';
import { workspace } from 'vscode';
import { editFile } from './fs.js';
import * as settings from '../../config/settings.js';

// ---------------------------------------------------------------------------
// EDIT-PIPELINE ORACLE.
//
// Every guard in edit_file is validated by fixtures I invented, which is exactly
// how the Python-indent scanner and the delimiter heuristic both passed their
// tests while being wrong on real code. So: generate edits from REAL source and
// check two properties that must hold by construction.
//
//   ORACLE 1 (no false refusals) — a token-aligned rename of a uniquely-occurring
//   identifier is always a legitimate edit. edit_file must APPLY it, and the
//   result must be exactly the intended text. Any refusal here is a guard
//   blocking real work.
//
//   ORACLE 2 (no missed corruption) — a search string that cuts an identifier in
//   half, or a replacement that drops a block's closing brace, always corrupts.
//   edit_file must REFUSE, and the file must be untouched.
//
// Source: SideCar's own TypeScript — a few hundred real files, none of them
// written with these guards in mind.
// ---------------------------------------------------------------------------

const SRC = pathNode.join(__dirname, '..', '..');

function realFiles(limit: number): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    for (const entry of fsNode.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const p = pathNode.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__fixtures__' || entry.name === '__mocks__') continue;
        walk(p);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const text = fsNode.readFileSync(p, 'utf-8');
        if (text.length > 200 && text.length < 60_000) out.push({ path: `src/${entry.name}`, text });
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * TypeScript reserved words. The first run of this oracle "renamed" `export` to
 * `exportRenamed` and reported the guard as broken — the guard was right and the
 * ORACLE was wrong. Generators need calibrating too.
 */
const KEYWORDS = new Set([
  'export',
  'import',
  'function',
  'return',
  'interface',
  'extends',
  'implements',
  'constructor',
  'default',
  'require',
  'typeof',
  'instanceof',
  'readonly',
  'private',
  'public',
  'protected',
  'static',
  'abstract',
  'declare',
  'namespace',
  'module',
  'string',
  'number',
  'boolean',
  'undefined',
  'unknown',
  'continue',
  'switch',
  'delete',
  'yield',
  'await',
  'async',
  'const',
  'class',
  'super',
  'catch',
  'finally',
  'throw',
  'while',
  'break',
  'case',
]);

/** A line that contains a uniquely-occurring identifier, usable as a token-aligned anchor. */
function pickRenameableLine(text: string): { line: string; ident: string } | null {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 12 || trimmed.length > 90) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import')) continue;
    // The whole LINE must be unique so edit_file's ambiguity guard doesn't fire.
    if (text.split(line).length - 1 !== 1) continue;
    const idents = trimmed.match(/\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g);
    if (!idents) continue;
    for (const ident of idents) {
      if (KEYWORDS.has(ident)) continue; // renaming a keyword is not a rename
      // The identifier must also be safely renameable: no other identifier
      // contains it as a substring (that would be a different edit entirely).
      const asSubstring = new RegExp(`[A-Za-z0-9_]${ident}|${ident}[A-Za-z0-9_]`).test(text);
      if (!asSubstring) return { line, ident };
    }
  }
  return null;
}

function mockFs(original: string) {
  vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
  let written: string | null = null;
  vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_u, c) => {
    written = Buffer.from(c as Uint8Array).toString('utf-8');
  });
  return () => written;
}

describe('EDIT ORACLE 1: legitimate edits are never refused', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies a token-aligned rename on real source files, byte-exactly', async () => {
    const files = realFiles(120);
    expect(files.length).toBeGreaterThan(40); // the corpus itself must be real

    const refused: string[] = [];
    const wrong: string[] = [];
    let applied = 0;

    for (const f of files) {
      const pick = pickRenameableLine(f.text);
      if (!pick) continue;

      const search = pick.line;
      const replace = pick.line.replace(new RegExp(`\\b${pick.ident}\\b`, 'g'), `${pick.ident}Renamed`);
      if (replace === search) continue;

      const expected = f.text.replace(search, replace);
      const readWritten = mockFs(f.text);

      try {
        await editFile({ path: f.path, search, replace });
        const got = readWritten();
        if (got !== expected) wrong.push(`${f.path}: applied but result differs`);
        else applied++;
      } catch (e) {
        refused.push(`${f.path}: ${(e as Error).message.slice(0, 90)}`);
      }
      vi.restoreAllMocks();
    }

    // Every one of these is a real, valid rename. A refusal is a guard blocking
    // legitimate work; a wrong result is corruption.
    expect(applied).toBeGreaterThan(20);
    expect(refused.slice(0, 5)).toEqual([]);
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe('EDIT ORACLE 2: corrupting edits are never applied', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses a search string that cuts an identifier in half, on real source', async () => {
    const files = realFiles(60);
    const missed: string[] = [];
    let caught = 0;

    for (const f of files) {
      const pick = pickRenameableLine(f.text);
      if (!pick) continue;

      // Cut the identifier in half — the live corruption (`greet(name: string): s`).
      const half = pick.ident.slice(0, Math.max(3, Math.floor(pick.ident.length / 2)));
      const idx = pick.line.indexOf(pick.ident);
      if (idx === -1) continue;
      const search = pick.line.slice(0, idx + half.length); // ends mid-token
      if (f.text.split(search).length - 1 !== 1) continue; // must be unique

      const readWritten = mockFs(f.text);
      try {
        await editFile({ path: f.path, search, replace: `${search}_MANGLED` });
        if (readWritten() !== null) missed.push(`${f.path}: mid-token splice APPLIED`);
      } catch {
        caught++;
      }
      vi.restoreAllMocks();
    }

    expect(caught).toBeGreaterThan(5);
    expect(missed.slice(0, 5)).toEqual([]);
  });

  it('refuses a replacement that drops a block’s closing brace, on real source', async () => {
    const files = realFiles(60);
    const missed: string[] = [];
    let caught = 0;

    for (const f of files) {
      // Find a unique line that closes a block, and delete the brace.
      const lines = f.text.split('\n');
      const closing = lines.find((l) => l.trim() === '}' && f.text.split(`\n${l}\n`).length - 1 === 1);
      if (!closing) continue;

      const readWritten = mockFs(f.text);
      try {
        await editFile({ path: f.path, search: `\n${closing}\n`, replace: '\n\n' }); // brace removed
        if (readWritten() !== null) missed.push(`${f.path}: unbalanced result APPLIED`);
      } catch {
        caught++;
      }
      vi.restoreAllMocks();
    }

    expect(caught).toBeGreaterThan(3);
    expect(missed.slice(0, 5)).toEqual([]);
  });
});
