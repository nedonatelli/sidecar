import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFile, writeFile, editFile } from './fs.js';
import { detectEol, findEditMatch } from './editMatch.js';

// BLACKBOX — the byte-domain matrix.
//
// Every other fixture in this suite is a TypeScript string literal, so the test
// and the implementation share one author's model of what a file contains. That
// is precisely how edit_file shipped unable to edit a CRLF file on any
// multi-line search while 8,350 tests passed: nothing in the suite had ever
// seen a `\r`.
//
// These fixtures are real files, written from outside the TS source, checked in
// with `-text` so git cannot normalize them (see __corpus__/.gitattributes).
// The tools run against the real bytes.
//
// The assertions are deliberately NOT "the edit succeeds" — for some inputs a
// principled refusal is the correct answer. What is asserted is that the tools
// never CORRUPT: what they did not intend to change comes back byte-identical.

// __dirname, not import.meta: this file compiles to CommonJS under tsc -p ./
const CORPUS_DIR = path.join(__dirname, '__corpus__');
const CORPUS = fs
  .readdirSync(CORPUS_DIR)
  .filter((f) => !f.startsWith('.') && f !== 'README.md')
  .sort();

/** Point the tools at a scratch copy of the corpus, then read back real bytes. */
let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-bytes-'));
  for (const name of CORPUS) fs.copyFileSync(path.join(CORPUS_DIR, name), path.join(root, name));

  const { workspace, Uri } = await import('vscode');
  vi.spyOn(Uri, 'joinPath').mockImplementation(
    (_base: unknown, ...parts: string[]) => ({ fsPath: path.join(root, ...parts) }) as never,
  );
  vi.spyOn(workspace.fs, 'readFile').mockImplementation(async (uri: unknown) =>
    fs.readFileSync((uri as { fsPath: string }).fsPath),
  );
  vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (uri: unknown, content: unknown) => {
    fs.writeFileSync((uri as { fsPath: string }).fsPath, content as Uint8Array);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const bytesOf = (name: string): Buffer => fs.readFileSync(path.join(root, name));
const textOf = (name: string): string => bytesOf(name).toString('utf-8');

describe('byte-domain corpus', () => {
  it('covers the properties the matrix is meant to exercise', () => {
    // A guard on the guard: if someone deletes the CRLF fixture, the matrix
    // below silently stops testing the thing it exists for.
    expect(CORPUS).toContain('crlf.ts');
    expect(CORPUS).toContain('cr.ts');
    expect(CORPUS).toContain('mixed-eol.ts');
    expect(CORPUS).toContain('bom-lf.ts');
    expect(CORPUS).toContain('no-final-nl.ts');
    expect(CORPUS.length).toBeGreaterThanOrEqual(15);
  });

  it('git has not normalized the fixtures out from under us', () => {
    // If core.autocrlf or a stray editor save rewrites these, every CRLF
    // assertion below passes vacuously. Check the bytes, not the intent.
    expect(fs.readFileSync(path.join(CORPUS_DIR, 'crlf.ts')).includes(Buffer.from('\r\n'))).toBe(true);
    expect(fs.readFileSync(path.join(CORPUS_DIR, 'lf.ts')).includes(Buffer.from('\r'))).toBe(false);
    const cr = fs.readFileSync(path.join(CORPUS_DIR, 'cr.ts'));
    expect(cr.includes(Buffer.from('\r'))).toBe(true);
    expect(cr.includes(Buffer.from('\n'))).toBe(false);
  });
});

describe('read_file over the byte domain', () => {
  for (const name of CORPUS) {
    it(`returns ${name} without altering it on disk`, async () => {
      const before = bytesOf(name);
      await readFile({ path: name });
      expect(bytesOf(name).equals(before)).toBe(true);
    });
  }

  it('a full read round-trips through write_file byte-for-byte', async () => {
    // The contract a model relies on when it rewrites a whole file: what it
    // read is what it can write back. BOM, CRLF and all.
    for (const name of CORPUS.filter((n) => n.endsWith('.ts') || n.endsWith('.md') || n.endsWith('.py'))) {
      const before = bytesOf(name);
      const content = await readFile({ path: name });
      await writeFile({ path: name, content }, { filesReadThisTurn: new Set([name]) } as never);
      expect({ name, equal: bytesOf(name).equals(before) }).toEqual({ name, equal: true });
    }
  });
});

describe('edit_file over the byte domain', () => {
  /** The first pair of ADJACENT non-blank lines, reconstructed with LF. */
  const adjacentPair = (text: string): string | null => {
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i].trim() !== '' && lines[i + 1].trim() !== '') return `${lines[i]}\n${lines[i + 1]}`;
    }
    return null;
  };

  const withPair = CORPUS.filter((n) => adjacentPair(fs.readFileSync(path.join(CORPUS_DIR, n), 'utf-8')) !== null);

  // SELF-SEARCH. A span taken from the file must be findable in it — even when
  // the model reconstructs it with LF, which is what every model does. Asserted
  // at the matcher, so no language grammar is involved and it applies to every
  // fixture uniformly. This is the property that would have caught CRLF on day
  // one; it is trivially true of a correct matcher.
  for (const name of withPair) {
    it(`self-search: a two-line span of ${name} is findable via LF`, () => {
      const text = textOf(name);
      const search = adjacentPair(text)!;
      const m = findEditMatch(text, search, search);
      expect(m).not.toBeNull();
      // And the span it names really is that text, modulo the tolerated difference.
      expect(text.slice(m!.start, m!.end).replace(/\r\n|\r/g, '\n')).toBe(search);
    });
  }

  // EOL PRESERVATION, end to end through the real tool. Table-driven: an edit
  // has to be semantically valid in the fixture's language, and generating one
  // produces nonsense (a `//` comment in Python). Universal properties below
  // stay automatic; this one is explicit on purpose.
  const SAFE_EDITS: Record<string, { search: string; replace: string }> = {
    'crlf.ts': {
      search: 'export function f(): number {\n  return 1;',
      replace: 'export function f(): number {\n  return 2;',
    },
    'lf.ts': {
      search: 'export function f(): number {\n  return 1;',
      replace: 'export function f(): number {\n  return 2;',
    },
    'crlf.py': { search: 'def sub(a, b):\n    return a - b', replace: 'def sub(a, b):\n    return b - a' },
    'crlf.md': { search: '- item one\n- item two', replace: '- item one\n- item two\n- item three' },
    'mixed-eol.ts': { search: 'const a = 1;\nconst b = 2;', replace: 'const a = 9;\nconst b = 8;' },
    'tabs.ts': { search: '\tif (true) {\n\t\treturn 1;', replace: '\tif (true) {\n\t\treturn 2;' },
    'trailing-ws.ts': { search: 'const a = 1;\nconst b = 2;', replace: 'const a = 9;\nconst b = 8;' },
    'bom-crlf.ts': {
      search: 'export const x = 1;\nexport const y = 2;',
      replace: 'export const x = 9;\nexport const y = 8;',
    },
  };

  for (const [name, edit] of Object.entries(SAFE_EDITS)) {
    it(`preserves ${name}'s line-ending convention through a real edit`, async () => {
      const before = textOf(name);
      const eolBefore = detectEol(before);

      const result = await editFile({ path: name, ...edit }, { filesReadThisTurn: new Set([name]) } as never);
      expect(result).toContain('File edited');

      const after = textOf(name);
      expect(after).not.toBe(before); // the edit really landed
      expect(detectEol(after).eol).toBe(eolBefore.eol);
      if (eolBefore.uniform && eolBefore.eol === '\r\n') {
        expect(/[^\r]\n/.test(after)).toBe(false); // no LF-only line crept in
      }
    });
  }

  it('KNOWN LIMIT: a lone-CR file matches, but a comment-introducing edit is refused', async () => {
    // Recorded, not hidden. The matcher handles CR correctly — the span is
    // found and spliced. The SYNTAX guard then refuses, because tree-sitter
    // does not treat a lone \r as a line terminator, so an inserted `//`
    // comments out the rest of the file. The language spec disagrees with the
    // parser here; the guard failing CLOSED (refuse, file untouched) is the
    // right side to err on, and classic-Mac line endings are extinct enough
    // that chasing it is not worth a parser fork.
    const before = bytesOf('cr.ts');
    const err = await editFile(
      {
        path: 'cr.ts',
        search: 'export function f(): number {\n  return 1;',
        replace: 'export function f(): number {\n  return 1;\n// note',
      },
      { filesReadThisTurn: new Set(['cr.ts']) } as never,
    ).catch((e: Error) => e.message);

    expect(err).toContain('syntax error');
    expect(bytesOf('cr.ts').equals(before)).toBe(true);

    // A comment-free edit to the same file is fine, and stays CR.
    await editFile(
      {
        path: 'cr.ts',
        search: 'export function f(): number {\n  return 1;',
        replace: 'export function f(): number {\n  return 2;',
      },
      { filesReadThisTurn: new Set(['cr.ts']) } as never,
    );
    expect(textOf('cr.ts')).toBe('export function f(): number {\r  return 2;\r}\r');
  });

  it('IDENTITY: replacing a span with itself leaves every file byte-identical', async () => {
    // The strongest single property in the edit path. It catches EOL rewriting,
    // $-expansion, and span arithmetic in one assertion, across the whole corpus.
    for (const name of CORPUS) {
      const before = bytesOf(name);
      const text = before.toString('utf-8');
      const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
      if (lines.length < 2) continue;
      const search = `${lines[0]}\n${lines[1]}`;

      await editFile({ path: name, search, replace: search }, { filesReadThisTurn: new Set([name]) } as never).catch(
        () => undefined, // a refusal is fine; a corruption is not
      );
      expect({ name, equal: bytesOf(name).equals(before) }).toEqual({ name, equal: true });
    }
  });

  it('LOCALITY: bytes outside the edited region are untouched', async () => {
    const name = 'crlf.py';
    const before = textOf(name);
    await editFile(
      { path: name, search: 'def sub(a, b):\n    return a - b', replace: 'def sub(a, b):\n    return b - a' },
      { filesReadThisTurn: new Set([name]) } as never,
    );
    const after = textOf(name);
    // Everything up to the edited function is identical, byte for byte.
    const prefix = before.slice(0, before.indexOf('def sub'));
    expect(after.startsWith(prefix)).toBe(true);
    expect(after).toContain('def add(a, b):\r\n    return a + b');
  });

  it('REFUSAL IS INERT: a rejected edit changes nothing on disk', async () => {
    for (const name of CORPUS) {
      const before = bytesOf(name);
      await editFile({ path: name, search: 'text that is definitely not in any fixture', replace: 'x' }, {
        filesReadThisTurn: new Set([name]),
      } as never).catch(() => undefined);
      expect({ name, equal: bytesOf(name).equals(before) }).toEqual({ name, equal: true });
    }
  });
});
