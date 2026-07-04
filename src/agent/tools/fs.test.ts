import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, editFile, readFile } from './fs.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../audit/auditBuffer.js';
import * as settings from '../../config/settings.js';

describe('writeFile audit mode', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('buffers write to AuditBuffer when agentMode is audit', async () => {
    getConfigSpy.mockReturnValue({ agentMode: 'audit' } as never);
    const context = { config: { agentMode: 'audit' } as never };
    const result = await writeFile({ path: 'src/app.ts', content: 'const x = 1;' }, context);
    expect(result).toContain('buffered for audit review');
    expect(buf.read('src/app.ts').buffered).toBe(true);
  });

  it('buffers write with correct content', async () => {
    getConfigSpy.mockReturnValue({ agentMode: 'audit' } as never);
    const context = { config: { agentMode: 'audit' } as never };
    await writeFile({ path: 'src/foo.ts', content: 'hello world' }, context);
    const state = buf.read('src/foo.ts');
    expect(state.buffered).toBe(true);
    expect(state.content).toBe('hello world');
  });

  it('does not buffer when agentMode is not audit', async () => {
    getConfigSpy.mockReturnValue({ agentMode: 'autonomous' } as never);
    const context = { config: { agentMode: 'autonomous' } as never };
    // Will try to do a real write, but we don't care — we just verify the buffer is empty
    await writeFile({ path: 'src/x.ts', content: 'data' }, context).catch(() => {});
    expect(buf.read('src/x.ts').buffered).toBe(false);
  });
});

describe('editFile audit mode', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('edits buffered content in AuditBuffer when agentMode is audit', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // First write a file to the buffer
    await buf.write('src/edit.ts', 'const old = 1;\nconst keep = 2;', async () => undefined);
    // Then edit it
    const result = await editFile(
      { path: 'src/edit.ts', search: 'const old = 1;', replace: 'const new_ = 99;' },
      context,
    );
    expect(result).toContain('buffered for audit review');
    const state = buf.read('src/edit.ts');
    expect(state.content).toContain('const new_ = 99;');
  });

  it('returns error when search text not found in buffered content', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/edit2.ts', 'const keep = 1;', async () => undefined);
    const result = await editFile({ path: 'src/edit2.ts', search: 'NOT_IN_FILE', replace: 'replacement' }, context);
    expect(result).toContain('edit_file failed');
  });

  it('returns error when search string appears multiple times in buffered content', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/multi.ts', 'const x = 1;\nconst x = 1;\n', async () => undefined);
    const result = await editFile({ path: 'src/multi.ts', search: 'const x = 1;', replace: 'const y = 2;' }, context);
    expect(result).toContain('appears 2 times');
    expect(result).toContain('NOT modified');
    // File must be unchanged
    expect(buf.read('src/multi.ts').content).toBe('const x = 1;\nconst x = 1;\n');
  });

  it('returns error when search and replace are identical (no-op guard)', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/noop.ts', 'const x = 1;', async () => undefined);
    const result = await editFile({ path: 'src/noop.ts', search: 'const x = 1;', replace: 'const x = 1;' }, context);
    expect(result).toContain('identical');
    // File must be unchanged
    const state = buf.read('src/noop.ts');
    expect(state.content).toBe('const x = 1;');
  });

  it('appends partial-replace warning when replace is a short substring of search', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // Simulate the gemma4 pattern: search = full function signature,
    // replace = just the return type keyword (which appears inside search).
    // search: "export function getAnswer(): string {" (38 chars)
    // replace: "string" (6 chars) — IS a substring of search → warning fires
    const fullSig = 'export function getAnswer(): string {';
    await buf.write('src/partial.ts', `${fullSig}\n  return 42;\n}\n`, async () => undefined);
    const result = await editFile({ path: 'src/partial.ts', search: fullSig, replace: 'string' }, context);
    expect(result).toContain('File edited');
    expect(result).toContain('Warning');
    expect(result).toContain('substring');
  });

  it('reads from disk via workspace when file is not in buffer', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('disk content here') as never);
    const result = await editFile(
      { path: 'src/fresh.ts', search: 'disk content', replace: 'replaced content' },
      context,
    );
    expect(result).toContain('buffered for audit review');
    vi.restoreAllMocks();
  });

  it('applies inferred edit when search=replace (intent inference steers gemma4)', async () => {
    // Gemma4 writes the DESIRED new text in both search and replace.
    // Intent inference finds the closest matching region and applies the edit
    // rather than failing — "steer the model's action rather than fight it."
    const context = { config: { agentMode: 'audit' } as never };
    const fileContent = [
      '// Direct invocations of eslint / tsc, OR common npm/pnpm/yarn script',
      '// names that conventionally run lint or type-checking.',
      'if (/\\b(eslint|tsc)\\b/.test(cmd)) {',
      '  state.lintObserved = true;',
      '}',
    ].join('\n');
    await buf.write('src/gate.ts', fileContent, async () => undefined);
    const newText = '// Direct invocations of various linters (eslint, tsc, pylint, flake8)';
    const result = await editFile({ path: 'src/gate.ts', search: newText, replace: newText }, context);
    // Should succeed by applying the edit, not fail with an error
    expect(result).toContain('Applied inferred edit');
    expect(result).toContain('eslint / tsc'); // shows what was replaced
    // File should now contain the new text
    expect(buf.read('src/gate.ts').content).toContain('pylint, flake8');
  });

  it('returns grep-based line hint when search string is not found in buffered content', async () => {
    // Grep hint is now preferred over nearest-match: returns exact line numbers
    // so the model can call read_file(start_line=N) to get the exact text.
    const context = { config: { agentMode: 'audit' } as never };
    const fileContent = [
      '// Direct invocations of eslint / tsc, OR common npm/pnpm/yarn script',
      '// names that conventionally run lint or type-checking.',
      'if (/\\b(eslint|tsc)\\b/.test(cmd)) {',
      '  state.lintObserved = true;',
      '}',
    ].join('\n');
    await buf.write('src/gate.ts', fileContent, async () => undefined);
    const search = '// Direct invocations of various linters (eslint, tsc, pylint)';
    const replace = '// Direct invocations of various linters (eslint, tsc, pylint, flake8)';
    const result = await editFile({ path: 'src/gate.ts', search, replace }, context);
    expect(result).toContain('search string not found');
    // Grep hint shows exact line numbers and read_file suggestion
    expect(result).toMatch(/line \d+:|Grep for|read_file/);
    expect(result).toContain('eslint'); // the grep found the real line
  });

  it('returns error when disk file is missing and not buffered', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await editFile({ path: 'src/missing.ts', search: 'something', replace: 'other' }, context);
    expect(result).toContain('Error: File not found');
    vi.restoreAllMocks();
  });

  it('returns error for deleted buffered file', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // Write then delete to mark as deleted in buffer
    await buf.write('src/deleted.ts', 'original content', async () => undefined);
    await buf.deleteFile('src/deleted.ts', async () => 'original content');
    const result = await editFile({ path: 'src/deleted.ts', search: 'anything', replace: 'other' }, context);
    expect(result).toContain('Error');
    expect(result).toContain('deleted');
  });
});

describe('editFile repeated-failure escalation', () => {
  // Root-caused via a local SWE-bench repro: gemma4:e4b submitted an identical
  // search===replace edit_file call twice in a row (same hint both times,
  // no self-correction), then cycle detection bailed the run with zero edits
  // ever landing. search===replace carries NO information about the intended
  // change (both fields are identical), so the only lever there is a blunter
  // message + a more precise (grep, line-numbered) hint on repeat.
  //
  // search-not-found is different: findIntentTarget has real signal (the
  // `replace` text's keyword overlap with a DIFFERENT existing region), just
  // gated behind a confidence threshold. A follow-up repro showed the model
  // re-reading the file after the escalation but still resubmitting the same
  // failing call — re-running the SAME deterministic check at the SAME
  // threshold would reject again for the same reason, so a verbatim 3rd
  // failure retries at a LOOSENED threshold and auto-applies if it now finds
  // a (lower-confidence, clearly disclosed) candidate.
  let buf: AuditBuffer;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
  });

  it('search===replace: first failure is the normal hint, an identical repeat escalates', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    await buf.write('src/dup.ts', 'const line = 1;\nconst other = 2;\n', async () => undefined);
    const call = { path: 'src/dup.ts', search: 'const line = 1;', replace: 'const line = 1;' };

    const first = await editFile(call, context);
    expect(first).toContain('identical');
    expect(first).not.toContain('AGAIN');

    const second = await editFile(call, context);
    expect(second).toContain('AGAIN');
    expect(second).toContain('read_file');
  });

  it('a DIFFERENT search/replace pair after a failure does not escalate', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    await buf.write('src/dup2.ts', 'const line = 1;\nconst other = 2;\n', async () => undefined);
    await editFile({ path: 'src/dup2.ts', search: 'const line = 1;', replace: 'const line = 1;' }, context);
    const different = await editFile(
      { path: 'src/dup2.ts', search: 'const other = 2;', replace: 'const other = 2;' },
      context,
    );
    expect(different).toContain('identical');
    expect(different).not.toContain('AGAIN');
  });

  it('search-not-found: an identical repeat escalates too', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    await buf.write('src/notfound.ts', 'const keep = 1;\n', async () => undefined);
    const call = { path: 'src/notfound.ts', search: 'totally missing text', replace: 'new text' };

    const first = await editFile(call, context);
    expect(first).toContain('search string not found');
    expect(first).not.toContain('AGAIN');

    const second = await editFile(call, context);
    expect(second).toContain('AGAIN');
  });

  it('a successful edit clears the failure signature so a later identical failure does not spuriously escalate', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    await buf.write('src/clear.ts', 'const a = 1;\nconst b = 2;\n', async () => undefined);
    const badCall = { path: 'src/clear.ts', search: 'const a = 1;', replace: 'const a = 1;' };

    await editFile(badCall, context); // fails, records the signature
    await editFile({ path: 'src/clear.ts', search: 'const b = 2;', replace: 'const b = 99;' }, context); // succeeds, clears it

    const repeatBad = await editFile(badCall, context);
    expect(repeatBad).toContain('identical');
    expect(repeatBad).not.toContain('AGAIN');
  });

  it('never escalates when the tracker is absent (unit tests / non-loop calls)', async () => {
    const context = { config: { agentMode: 'audit' } as never }; // no editFailureSignatures
    await buf.write('src/notracker.ts', 'const line = 1;\n', async () => undefined);
    const call = { path: 'src/notracker.ts', search: 'const line = 1;', replace: 'const line = 1;' };
    const first = await editFile(call, context);
    const second = await editFile(call, context);
    expect(first).not.toContain('AGAIN');
    expect(second).not.toContain('AGAIN');
  });

  it('disk mode (non-audit): an identical search-not-found repeat escalates', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('const keep = 1;\n') as never);
    const context = { editFailureSignatures: new Map<string, string>() };
    const call = { path: 'src/disk-notfound.ts', search: 'totally missing text', replace: 'new text' };

    const first = await editFile(call, context);
    expect(first).toContain('search string not found');
    expect(first).not.toContain('AGAIN');

    const second = await editFile(call, context);
    expect(second).toContain('AGAIN');
    vi.restoreAllMocks();
  });

  it('search-not-found: a 3rd identical repeat auto-repairs via a loosened confidence match', async () => {
    // "alpha" is the only one of 5 candidate words (alpha/beta/gamma/delta/
    // epsilon) present near the target line: score=1 passes the loosened 20%
    // threshold (ceil(5*0.2)=1) but not the default 40% (ceil(5*0.4)=2) —
    // exactly the gap the 3rd-strike retry is designed to cross.
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    const fileContent = 'function foo() {\n  alpha zzzz zzzz zzzz zzzz;\n  return 1;\n}\n';
    await buf.write('src/loose.ts', fileContent, async () => undefined);
    const call = { path: 'src/loose.ts', search: 'totally missing text', replace: 'alpha beta gamma delta epsilon' };

    const first = await editFile(call, context);
    expect(first).toContain('search string not found');
    expect(first).not.toContain('AGAIN');

    const second = await editFile(call, context);
    expect(second).toContain('AGAIN');
    expect(second).not.toContain('Auto-repaired');

    const third = await editFile(call, context);
    expect(third).toContain('Auto-repaired');
    expect(third).toContain('3 identical failed attempts');
    expect(third).toContain('VERIFY');
    const state = buf.read('src/loose.ts');
    expect(state.content).toContain('alpha beta gamma delta epsilon');
    expect(state.content).not.toContain('zzzz zzzz zzzz zzzz');
  });

  it('disk mode: a 3rd identical repeat auto-repairs via a loosened confidence match', async () => {
    const { workspace } = await import('vscode');
    const fileContent = 'function foo() {\n  alpha zzzz zzzz zzzz zzzz;\n  return 1;\n}\n';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(fileContent) as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    const context = { editFailureSignatures: new Map<string, string>() };
    const call = {
      path: 'src/disk-loose.ts',
      search: 'totally missing text',
      replace: 'alpha beta gamma delta epsilon',
    };

    await editFile(call, context); // 1st
    await editFile(call, context); // 2nd (AGAIN)
    const third = await editFile(call, context); // 3rd (auto-repair)
    expect(third).toContain('Auto-repaired');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = Buffer.from(writeSpy.mock.calls[0][1] as Uint8Array).toString('utf-8');
    expect(written).toContain('alpha beta gamma delta epsilon');
    vi.restoreAllMocks();
  });

  it('search===replace: a 2nd+ repeat prefers a precise grep-based hint over the fuzzy nearest-match block', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    // No leading indentation on the target line — must match `search`
    // verbatim so findIntentTarget's steer attempt finds intentTarget===search
    // (a true no-op) and correctly falls through to escalation, rather than
    // succeeding on a whitespace-shifted "different" string by accident.
    const fileContent = 'function foo() {\nconst distinctiveMarker = 1;\nreturn distinctiveMarker;\n}\n';
    await buf.write('src/grephint.ts', fileContent, async () => undefined);
    const call = {
      path: 'src/grephint.ts',
      search: 'const distinctiveMarker = 1;',
      replace: 'const distinctiveMarker = 1;',
    };

    await editFile(call, context); // 1st: normal hint
    const second = await editFile(call, context); // 2nd: escalated, grep-preferred hint
    expect(second).toContain('AGAIN');
    expect(second).toContain('Grep for');
    expect(second).toMatch(/line \d+:/);
  });
});

describe('readFile audit mode', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('reads buffered content when audit mode is active', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/buffered.ts', 'buffered content', async () => undefined);
    const result = await readFile({ path: 'src/buffered.ts' }, context);
    expect(result).toContain('buffered content');
  });
});

// ---------------------------------------------------------------------------
// isSensitiveFile guard — write_file, edit_file, read_file must all block
// sensitive paths before they touch the filesystem or audit buffer.
// ---------------------------------------------------------------------------
describe('isSensitiveFile guard', () => {
  const sensitiveNames = [
    '.env',
    '.env.local',
    '.env.production',
    'credentials.json',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'secret.toml',
    'token.json',
    'service.account.json',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'private.key',
    'cert.pem',
    'client.p12',
    'bundle.pfx',
  ];

  const safeName = 'src/app.ts';

  describe('writeFile rejects sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`blocks write to ${name}`, async () => {
        const result = await writeFile({ path: name, content: 'data' });
        expect(result).toMatch(/Error.*secrets or credentials.*not permitted to write/i);
      });
    }

    it('allows write to a non-sensitive file', async () => {
      const { workspace } = await import('vscode');
      vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
      vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);
      const result = await writeFile({ path: safeName, content: 'export {}' });
      expect(result).toContain('File written');
      vi.restoreAllMocks();
    });
  });

  describe('editFile rejects sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`blocks edit of ${name}`, async () => {
        const result = await editFile({ path: name, search: 'x', replace: 'y' });
        expect(result).toMatch(/Error.*secrets or credentials.*not permitted to edit/i);
      });
    }
  });

  describe('readFile warns on sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`warns when reading ${name}`, async () => {
        const result = await readFile({ path: name });
        // read issues a Warning (not an Error) to avoid hard-blocking
        expect(result).toMatch(/Warning.*secrets or credentials/i);
      });
    }
  });
});

describe('readFile — file-not-found suggestions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws with suggestions when a same-named file exists elsewhere (is_error:true)', async () => {
    // Must throw (not return) so executor.ts sets is_error:true on the
    // tool_result — the eval harness and completion gate both check is_error
    // to detect file-not-found. The helpful message is still visible to the model.
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'FileNotFound' }),
    );
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/agent/loop.ts' } as never]);

    let err: Error | undefined;
    try {
      await readFile({ path: 'src/agent/loop/runAgentLoop.ts' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('File not found');
    expect(err!.message).toContain('Did you mean');
    expect(err!.message).toContain('src/agent/loop.ts');
  });

  it('throws a list_directory hint when no similarly-named file exists', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'FileNotFound' }));
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([]);

    let err: Error | undefined;
    try {
      await readFile({ path: 'src/nonexistent/ghost.ts' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('File not found');
    expect(err!.message).toContain('ghost.ts');
    expect(err!.message).toContain('list_directory');
  });

  it('re-throws non-ENOENT errors unchanged', async () => {
    const { workspace } = await import('vscode');
    const permError = Object.assign(new Error('Permission denied'), { code: 'NoPermissions' });
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(permError);

    await expect(readFile({ path: 'src/locked.ts' })).rejects.toThrow('Permission denied');
  });
});

describe('writeFile circular-rewrite block', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records the first write and soft-blocks a byte-identical re-write to the same path', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);

    const writeHistoryByFile = new Map<string, Set<string>>();
    const context = { writeHistoryByFile };
    const content = 'import tkinter as tk\nclass App: ...\n';

    const first = await writeFile({ path: 'gui.py', content }, context);
    expect(first).toBe('File written: gui.py');
    expect(writeHistoryByFile.get('gui.py')?.size).toBe(1);

    const second = await writeFile({ path: 'gui.py', content }, context); // identical
    expect(second).toContain('No change written');
    expect(second).toContain('edit_file');
    expect(workspace.fs.writeFile).toHaveBeenCalledTimes(1); // the no-op never hit disk
  });

  it('allows a write with different content to the same path (real progress)', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);

    const writeHistoryByFile = new Map<string, Set<string>>();
    const context = { writeHistoryByFile };
    await writeFile({ path: 'gui.py', content: 'v1' }, context);
    const second = await writeFile({ path: 'gui.py', content: 'v2' }, context);
    expect(second).toBe('File written: gui.py');
    expect(writeHistoryByFile.get('gui.py')?.size).toBe(2);
  });

  it('blocks a re-write of a non-current prior version (A -> B -> A circular)', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);

    const writeHistoryByFile = new Map<string, Set<string>>();
    const context = { writeHistoryByFile };
    await writeFile({ path: 'gui.py', content: 'A' }, context);
    await writeFile({ path: 'gui.py', content: 'B' }, context);
    const back = await writeFile({ path: 'gui.py', content: 'A' }, context); // circular back to A
    expect(back).toContain('No change written');
  });

  it('does nothing special when no writeHistoryByFile is provided (non-loop calls)', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    const a = await writeFile({ path: 'gui.py', content: 'same' }, {});
    const b = await writeFile({ path: 'gui.py', content: 'same' }, {});
    expect(a).toBe('File written: gui.py');
    expect(b).toBe('File written: gui.py');
  });
});

describe('writeFile enforce-edit-over-rewrite block', () => {
  afterEach(() => vi.restoreAllMocks());

  async function mockedWrite(input: Record<string, unknown>, context: Record<string, unknown>) {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    return writeFile(input, context);
  }

  it('soft-blocks a full write_file once the file has been edited via edit_file', async () => {
    const filesEditedViaEditTool = new Set<string>(['gui_calculator.py']);
    const r = await mockedWrite({ path: 'gui_calculator.py', content: 'whole new file' }, { filesEditedViaEditTool });
    expect(r).toContain('was NOT applied');
    expect(r).toContain('edit_file');
  });

  it('matches the edited file by basename (relative vs absolute path)', async () => {
    const filesEditedViaEditTool = new Set<string>(['/abs/proj/gui_calculator.py']);
    const r = await mockedWrite({ path: 'gui_calculator.py', content: 'x' }, { filesEditedViaEditTool });
    expect(r).toContain('was NOT applied');
  });

  it('allows write_file to a file that has NOT been edited (e.g. a fresh create)', async () => {
    const filesEditedViaEditTool = new Set<string>(['other.py']);
    const r = await mockedWrite({ path: 'gui_calculator.py', content: 'x' }, { filesEditedViaEditTool });
    expect(r).toBe('File written: gui_calculator.py');
  });

  it('does NOT block a same-basename file in a different dir (suffix match, not basename)', async () => {
    const filesEditedViaEditTool = new Set<string>(['src/util.py']);
    const r = await mockedWrite({ path: 'test/util.py', content: 'x' }, { filesEditedViaEditTool });
    expect(r).toBe('File written: test/util.py'); // src/util.py lock must not trap test/util.py
  });

  it('is skipped entirely when no filesEditedViaEditTool is provided', async () => {
    const r = await mockedWrite({ path: 'gui_calculator.py', content: 'x' }, {});
    expect(r).toBe('File written: gui_calculator.py');
  });
});

describe('writeFile verify-before-rewrite block', () => {
  afterEach(() => vi.restoreAllMocks());

  async function mockedWrite(input: Record<string, unknown>, context: Record<string, unknown>) {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    return writeFile(input, context);
  }

  it('allows the create + 2 rewrites, then soft-blocks the 4th unverified rewrite', async () => {
    const writesSinceVerifyByFile = new Map<string, number>();
    const ctx = { writesSinceVerifyByFile };
    for (let i = 0; i < 3; i++) {
      const r = await mockedWrite({ path: 'gui.py', content: `v${i}` }, ctx);
      expect(r).toBe('File written: gui.py');
    }
    const blocked = await mockedWrite({ path: 'gui.py', content: 'v3' }, ctx);
    expect(blocked).toContain('was NOT applied');
    expect(blocked).toContain('get_diagnostics');
  });

  it('keeps blocking further unverified rewrites until the counter is reset', async () => {
    const writesSinceVerifyByFile = new Map<string, number>([['gui.py', 3]]); // already at threshold
    const ctx = { writesSinceVerifyByFile };
    expect(await mockedWrite({ path: 'gui.py', content: 'x' }, ctx)).toContain('was NOT applied');
    expect(await mockedWrite({ path: 'gui.py', content: 'y' }, ctx)).toContain('was NOT applied');
  });

  it('resumes writing after the counter is reset to 0 (verification happened)', async () => {
    const writesSinceVerifyByFile = new Map<string, number>([['gui.py', 5]]);
    const ctx = { writesSinceVerifyByFile };
    writesSinceVerifyByFile.set('gui.py', 0); // simulate a verification reset
    expect(await mockedWrite({ path: 'gui.py', content: 'fixed' }, ctx)).toBe('File written: gui.py');
  });

  it('tracks the counter per file (rewriting A does not block B)', async () => {
    const writesSinceVerifyByFile = new Map<string, number>();
    const ctx = { writesSinceVerifyByFile };
    for (let i = 0; i < 4; i++) await mockedWrite({ path: 'a.py', content: `a${i}` }, ctx);
    // b.py is untouched, so its first write is fine.
    expect(await mockedWrite({ path: 'b.py', content: 'b0' }, ctx)).toBe('File written: b.py');
  });

  it('is skipped when no writesSinceVerifyByFile is provided (non-loop calls)', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await mockedWrite({ path: 'gui.py', content: `v${i}` }, {})).toBe('File written: gui.py');
    }
  });
});

describe('streaming diff via onOutput', () => {
  const DIFF_PREFIX = '\x00diff\x00';

  it('editFile emits a unified diff via onOutput when content changes', async () => {
    const { workspace } = await import('vscode');
    const oldContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from(oldContent) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);

    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    const result = await editFile({ path: 'src/foo.ts', search: 'const y = 2;', replace: 'const y = 99;' }, context);

    expect(result).toBe('File edited: src/foo.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^\x00diff\x00/);
    const patch = chunks[0].slice(DIFF_PREFIX.length);
    expect(patch).toContain('--- a/src/foo.ts');
    expect(patch).toContain('+++ b/src/foo.ts');
    expect(patch).toContain('-const y = 2;');
    expect(patch).toContain('+const y = 99;');
    vi.restoreAllMocks();
  });

  it('editFile emits no diff when search === replace (error path, no write)', async () => {
    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    const result = await editFile({ path: 'src/foo.ts', search: 'same', replace: 'same' }, context);
    expect(result).toContain('Error');
    expect(chunks).toHaveLength(0);
  });

  it('writeFile emits diff via onOutput when file already exists', async () => {
    const { workspace } = await import('vscode');
    const original = 'line A\nline B\nline C\n';
    const newContent = 'line A\nline B modified\nline C\n';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from(original) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);

    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    const result = await writeFile({ path: 'src/bar.ts', content: newContent }, context);

    expect(result).toBe('File written: src/bar.ts');
    expect(chunks).toHaveLength(1);
    const patch = chunks[0].slice(DIFF_PREFIX.length);
    expect(patch).toContain('-line B');
    expect(patch).toContain('+line B modified');
    vi.restoreAllMocks();
  });

  it('writeFile emits all-additions diff when file is new', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);

    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    await writeFile({ path: 'src/new.ts', content: 'export const x = 1;\n' }, context);

    expect(chunks).toHaveLength(1);
    const patch = chunks[0].slice(DIFF_PREFIX.length);
    expect(patch).toContain('+export const x = 1;');
    vi.restoreAllMocks();
  });

  it('editFile emits no diff output when onOutput is absent', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('old') as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
    // No onOutput in context — should not throw
    const result = await editFile({ path: 'src/x.ts', search: 'old', replace: 'new' }, {});
    expect(result).toBe('File edited: src/x.ts');
    vi.restoreAllMocks();
  });
});
