import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace, window, Uri } from 'vscode';
import { handleAcceptAllChanges } from './fileHandlers.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../../agent/audit/auditBuffer.js';

// The change summary's Accept All, in audit mode: the agent's writes sit in
// the audit buffer, and accepting them writes them to disk. It used to flush
// the whole buffer with no conflict check and say "accepted" whatever
// happened. (#139)

let root: string;
let buf: AuditBuffer;

const onDisk = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const readDisk = async (rel: string) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf-8');
  } catch {
    return undefined;
  }
};
const makeState = () => ({ changelog: { clear: vi.fn() }, postMessage: vi.fn() });
const posted = (state: ReturnType<typeof makeState>) =>
  state.postMessage.mock.calls.map((c) => c[0] as { command: string; content: string });

describe('handleAcceptAllChanges — audit-buffered changes', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-all-'));
    (workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: { fsPath: root, scheme: 'file', path: root }, name: 'ws', index: 0 },
    ];
    vi.spyOn(Uri, 'joinPath').mockImplementation(((base: { fsPath: string }, ...segs: string[]) => {
      const p = path.join(base.fsPath, ...segs);
      return { fsPath: p, scheme: 'file', path: p };
    }) as never);
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((async (u: { fsPath: string }) =>
      fs.readFileSync(u.fsPath)) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation((async (u: { fsPath: string }, b: Uint8Array) =>
      fs.writeFileSync(u.fsPath, b)) as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockImplementation((async (u: { fsPath: string }) =>
      fs.mkdirSync(u.fsPath, { recursive: true })) as never);

    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    fs.writeFileSync(path.join(root, 'a.ts'), 'original a');
    fs.writeFileSync(path.join(root, 'b.ts'), 'original b');
    await buf.write('a.ts', 'agent a', readDisk);
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applies the changes the panel showed', async () => {
    const state = makeState();
    await handleAcceptAllChanges(state as never, ['a.ts']);
    expect(onDisk('a.ts')).toBe('agent a');
    expect(buf.has('a.ts')).toBe(false);
    expect(posted(state).some((m) => m.content.includes('accepted'))).toBe(true);
  });

  it('does not apply a change buffered after the panel was shown', async () => {
    await buf.write('b.ts', 'agent b, never reviewed', readDisk);
    await handleAcceptAllChanges(makeState() as never, ['a.ts']);
    expect(onDisk('a.ts')).toBe('agent a');
    expect(onDisk('b.ts')).toBe('original b');
    expect(buf.has('b.ts')).toBe(true);
  });

  it('asks before overwriting a file edited on disk since it was buffered, and keeps it on cancel', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'the user edited this');
    const ask = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const state = makeState();

    await handleAcceptAllChanges(state as never, ['a.ts']);

    expect(ask).toHaveBeenCalled();
    expect(onDisk('a.ts')).toBe('the user edited this');
    expect(buf.has('a.ts')).toBe(true);
    expect(posted(state).some((m) => m.content.includes('accepted'))).toBe(false);
    expect(posted(state).some((m) => m.command === 'error')).toBe(true);
  });

  it('does not report success when the flush fails', async () => {
    vi.spyOn(workspace.fs, 'writeFile').mockRejectedValue(new Error('disk full'));
    const state = makeState();

    await handleAcceptAllChanges(state as never, ['a.ts']);

    expect(buf.has('a.ts')).toBe(true);
    expect(posted(state).some((m) => m.content.includes('accepted'))).toBe(false);
    expect(posted(state).some((m) => m.command === 'error')).toBe(true);
  });
});
