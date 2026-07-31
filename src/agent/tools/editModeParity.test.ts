import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { editFile } from './fs.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';
import { handleReviewModeTool } from '../executor/reviewModeHandler.js';
import type { PendingEditStore } from '../pendingEdits.js';

// GREYBOX — differential testing across persistence modes.
//
// edit_file has three places to put the result: real disk, the audit buffer,
// and the review-mode pending store. It used to have three MATCHERS to decide
// the result, and they disagreed: review mode expanded `$&` as a regex
// reference, silently took the first of N matches, and skipped every guard.
// Nobody noticed for months, because each mode was only ever tested against
// itself.
//
// The property here does not care what the right answer is. It asserts the
// three modes reach the SAME answer — accept with the same bytes, or refuse.
// A divergence is a bug in whichever mode is the odd one out, and this test
// says so without needing to know which.

let root: string;

const CASES: { name: string; before: string; search: string; replace: string }[] = [
  {
    name: 'plain substitution',
    before: 'const a = 1;\nconst b = 2;\n',
    search: 'const b = 2;',
    replace: 'const b = 3;',
  },
  {
    name: 'replacement containing $-sequences',
    // The live review-mode corruption: `$&` expanded to the matched text.
    before: 'const price = "TBD";\n',
    search: 'const price = "TBD";',
    replace: 'const price = "$& $\' $1 $$";',
  },
  {
    name: 'ambiguous search (must be refused everywhere)',
    before: 'let x = 0;\nlet x = 0;\n',
    search: 'let x = 0;',
    replace: 'let x = 1;',
  },
  {
    name: 'search absent from the file',
    before: 'const a = 1;\n',
    search: 'const nowhere = 9;',
    replace: 'const nowhere = 10;',
  },
  {
    name: 'CRLF file with an LF multi-line search',
    before: 'const a = 1;\r\nconst b = 2;\r\n',
    search: 'const a = 1;\nconst b = 2;',
    replace: 'const a = 9;\nconst b = 8;',
  },
  {
    name: 'syntax-breaking replacement (must be refused everywhere)',
    before: 'export function f(): number {\n  return 1;\n}\n',
    search: 'export function f(): number {',
    replace: 'number',
  },
  {
    name: 'search splitting a token (must be refused everywhere)',
    before: 'const greeting = "hi";\n',
    search: 'greet',
    replace: 'welcome',
  },
  {
    name: 'edit already applied',
    before: 'export const welcome = 1;\n',
    search: 'export const greet = 1;',
    replace: 'export const welcome = 1;',
  },
];

/** What a mode did: the resulting bytes, or a refusal. */
type Outcome = { applied: true; text: string } | { applied: false };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-parity-'));
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
  vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([{ uri: { fsPath: root } }] as never);
  getDefaultAuditBuffer().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  getDefaultAuditBuffer().clear();
  fs.rmSync(root, { recursive: true, force: true });
});

async function onDisk(file: string, c: (typeof CASES)[number]): Promise<Outcome> {
  fs.writeFileSync(path.join(root, file), c.before);
  try {
    await editFile({ path: file, search: c.search, replace: c.replace });
  } catch {
    return { applied: false };
  }
  const after = fs.readFileSync(path.join(root, file), 'utf-8');
  return after === c.before ? { applied: false } : { applied: true, text: after };
}

async function inAuditBuffer(file: string, c: (typeof CASES)[number]): Promise<Outcome> {
  fs.writeFileSync(path.join(root, file), c.before);
  const buf = getDefaultAuditBuffer();
  const ctx = { config: { agentMode: 'audit' } } as never;
  try {
    await editFile({ path: file, search: c.search, replace: c.replace }, ctx);
  } catch {
    return { applied: false };
  }
  const state = buf.read(file);
  const after = state.buffered ? (state.content ?? '') : c.before;
  return after === c.before ? { applied: false } : { applied: true, text: after };
}

async function inReviewStore(file: string, c: (typeof CASES)[number]): Promise<Outcome> {
  fs.writeFileSync(path.join(root, file), c.before);
  let recorded: string | null = null;
  const store = {
    get: () => undefined,
    record: (_abs: string, _base: string | null, next: string) => {
      recorded = next;
    },
  } as unknown as PendingEditStore;

  const result = await handleReviewModeTool(
    { type: 'tool_use', id: 't1', name: 'edit_file', input: { path: file, search: c.search, replace: c.replace } },
    store,
  );
  if (result?.is_error) return { applied: false };
  return recorded !== null && recorded !== c.before ? { applied: true, text: recorded } : { applied: false };
}

describe('edit_file behaves identically across persistence modes', () => {
  const observed: Outcome[] = [];

  for (const c of CASES) {
    it(`${c.name}`, async () => {
      const file = 'subject.ts';
      const disk = await onDisk(file, c);
      const audit = await inAuditBuffer(file, c);
      const review = await inReviewStore(file, c);
      observed.push(disk);

      // Compare as one object so a divergence names all three at once.
      expect({ audit, review }).toEqual({ audit: disk, review: disk });
    });
  }

  it('the case set exercised both acceptance and refusal', () => {
    // Verify the instrument, not just the result: three modes that refuse
    // everything agree perfectly and prove nothing. Assert the observed
    // outcomes, not the case count — a vacuous suite must fail here.
    expect(observed).toHaveLength(CASES.length);
    expect(observed.filter((o) => o.applied).length).toBeGreaterThanOrEqual(3);
    expect(observed.filter((o) => !o.applied).length).toBeGreaterThanOrEqual(3);
  });
});
