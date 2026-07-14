import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, editFile, readFile } from './fs.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../audit/auditBuffer.js';
import * as settings from '../../config/settings.js';
import { workspace } from 'vscode';

/**
 * editFile THROWS on failure (v0.119: returned "Error: …" strings were recorded
 * by the executor as is_error=false, so failed edits looked like successes to
 * bounce escalation, cycle detection, and the completion gate). These tests
 * assert on the message either way, so capture both outcomes uniformly.
 */
const editMsg = async (...args: Parameters<typeof editFile>): Promise<string> =>
  editFile(...args).catch((e: Error) => e.message);
/**
 * write_file THROWS on a refusal (clobber guard, unverified-rewrite guard,
 * sensitive path) — returned "NOT applied" strings were recorded by the
 * executor as is_error=false, so a refused write looked like a success to the
 * loop's error accounting. Capture either outcome for assertions.
 */
const writeMsg = async (...args: Parameters<typeof writeFile>): Promise<string> =>
  writeFile(...args).catch((e: Error) => e.message);

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
    const result = await writeMsg({ path: 'src/app.ts', content: 'const x = 1;' }, context);
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
    const result = await editMsg(
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
    const err = await editMsg({ path: 'src/edit2.ts', search: 'NOT_IN_FILE', replace: 'replacement' }, context).catch(
      (e: Error) => e.message,
    );
    expect(err).toContain('edit_file failed');
  });

  it('returns error when search string appears multiple times in buffered content', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/multi.ts', 'const x = 1;\nconst x = 1;\n', async () => undefined);
    const err = await editMsg({ path: 'src/multi.ts', search: 'const x = 1;', replace: 'const y = 2;' }, context).catch(
      (e: Error) => e.message,
    );
    expect(err).toContain('appears 2 times');
    expect(err).toContain('NOT modified');
    // File must be unchanged
    expect(buf.read('src/multi.ts').content).toBe('const x = 1;\nconst x = 1;\n');
  });

  it('returns error when search and replace are identical (no-op guard)', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/noop.ts', 'const x = 1;', async () => undefined);
    const err = await editMsg({ path: 'src/noop.ts', search: 'const x = 1;', replace: 'const x = 1;' }, context).catch(
      (e: Error) => e.message,
    );
    expect(err).toContain('identical');
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
    const result = await editMsg({ path: 'src/partial.ts', search: fullSig, replace: 'string' }, context);
    expect(result).toContain('File edited');
    expect(result).toContain('Warning');
    expect(result).toContain('substring');
  });

  it('reads from disk via workspace when file is not in buffer', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('disk content here') as never);
    const result = await editMsg(
      { path: 'src/fresh.ts', search: 'disk content', replace: 'replaced content' },
      context,
    );
    expect(result).toContain('buffered for audit review');
    vi.restoreAllMocks();
  });

  it('SUGGESTS the region when search=replace, and never writes (fuzzy match is 30% wrong)', async () => {
    // Was: apply the inferred edit. The matcher picks the WRONG region in 30% of
    // the cases it commits to, measured over 1,700 real edits from 11 repos — and
    // a wrong region that parses is silent corruption the syntax guard cannot see.
    const context = { config: { agentMode: 'audit' } as never };
    const fileContent = [
      '// Direct invocations of eslint / tsc, OR common npm/pnpm/yarn script',
      'if (/\\b(eslint|tsc)\\b/.test(cmd)) {',
      '  state.lintObserved = true;',
      '}',
    ].join('\n');
    await buf.write('src/gate.ts', fileContent, async () => undefined);
    const newText = 'if (/\\b(eslint|tsc|pylint)\\b/.test(cmd)) {';

    const err = await editMsg({ path: 'src/gate.ts', search: newText, replace: newText }, context);

    expect(err).toMatch(/did not apply|identical/i);
    expect(err).toContain('closest matching region');
    expect(err).toContain('eslint'); // the candidate text is handed to the model
    // Critically: the buffer is untouched.
    expect(buf.read('src/gate.ts').content).toBe(fileContent);
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
    const result = await editMsg({ path: 'src/gate.ts', search, replace }, context);
    expect(result).toContain('search string not found');
    // Grep hint shows exact line numbers and read_file suggestion
    expect(result).toMatch(/line \d+:|Grep for|read_file/);
    expect(result).toContain('eslint'); // the grep found the real line
  });

  it('coerces edit_file(path, search) on a nonexistent file into a create (llama3.2 shape 1)', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await editMsg({ path: 'out/f1.md', search: 'k4q9-alpha' }, context);
    expect(result).toContain('did not exist');
    expect(result).toContain('write_file(path, content)');
    expect(buf.read('out/f1.md').content).toBe('k4q9-alpha');
  });

  it('coerces edit_file(path, replace) on a nonexistent file into a create (shape 3, replace wins)', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await editMsg({ path: 'out/f4.md', replace: 'mm05-delta' }, context);
    expect(result).toContain("'replace' text was written");
    expect(buf.read('out/f4.md').content).toBe('mm05-delta');
  });

  it('missing replace on an EXISTING file stays a hard error pointing at read_file', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/existing.ts', 'const x = 1;', async () => undefined);
    const result = await editMsg({ path: 'src/existing.ts', search: 'const x = 1;' }, context);
    expect(result).toContain("'replace' is missing");
    expect(result).toContain('read_file(path="src/existing.ts")');
    expect(buf.read('src/existing.ts').content).toBe('const x = 1;'); // untouched
  });

  it('errors with a write_file pointer when both search and replace are missing', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const result = await editMsg({ path: 'out/f9.md' }, context);
    expect(result).toContain("requires 'search'");
    expect(result).toContain('write_file(path="out/f9.md"');
    expect(buf.read('out/f9.md').buffered).toBe(false); // nothing created
  });

  it('points to write_file when the target file does not exist (audit path)', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await editMsg({ path: 'src/missing.ts', search: 'something', replace: 'other' }, context);
    expect(result).toContain('src/missing.ts does not exist');
    expect(result).toContain('write_file(path="src/missing.ts"');
    expect(result).not.toContain('/var/folders'); // no leaked absolute paths
    vi.restoreAllMocks();
  });

  it('points to write_file when the target file does not exist (non-audit path)', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(
      new Error("ENOENT: no such file or directory, open '/var/folders/xy/out/f1.md'"),
    );
    await expect(editFile({ path: 'out/f1.md', search: 'k4q9-alpha', replace: '' })).rejects.toThrow(
      /out\/f1\.md does not exist[\s\S]*write_file\(path="out\/f1\.md"/,
    );
    vi.restoreAllMocks();
  });

  it('returns error for deleted buffered file', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // Write then delete to mark as deleted in buffer
    await buf.write('src/deleted.ts', 'original content', async () => undefined);
    await buf.deleteFile('src/deleted.ts', async () => 'original content');
    const result = await editMsg({ path: 'src/deleted.ts', search: 'anything', replace: 'other' }, context);
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

    const first = await editMsg(call, context);
    expect(first).toContain('identical');
    expect(first).not.toContain('AGAIN');

    const second = await editMsg(call, context);
    expect(second).toContain('AGAIN');
    expect(second).toContain('read_file');
  });

  it('a DIFFERENT search/replace pair after a failure does not escalate', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    await buf.write('src/dup2.ts', 'const line = 1;\nconst other = 2;\n', async () => undefined);
    await editMsg({ path: 'src/dup2.ts', search: 'const line = 1;', replace: 'const line = 1;' }, context);
    const different = await editMsg(
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

    const first = await editMsg(call, context);
    expect(first).toContain('search string not found');
    expect(first).not.toContain('AGAIN');

    const second = await editMsg(call, context);
    expect(second).toContain('AGAIN');
  });

  it('a successful edit clears the failure signature so a later identical failure does not spuriously escalate', async () => {
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    await buf.write('src/clear.ts', 'const a = 1;\nconst b = 2;\n', async () => undefined);
    const badCall = { path: 'src/clear.ts', search: 'const a = 1;', replace: 'const a = 1;' };

    await editMsg(badCall, context); // fails, records the signature
    await editMsg({ path: 'src/clear.ts', search: 'const b = 2;', replace: 'const b = 99;' }, context); // succeeds, clears it

    const repeatBad = await editMsg(badCall, context);
    expect(repeatBad).toContain('identical');
    expect(repeatBad).not.toContain('AGAIN');
  });

  it('never escalates when the tracker is absent (unit tests / non-loop calls)', async () => {
    const context = { config: { agentMode: 'audit' } as never }; // no editFailureSignatures
    await buf.write('src/notracker.ts', 'const line = 1;\n', async () => undefined);
    const call = { path: 'src/notracker.ts', search: 'const line = 1;', replace: 'const line = 1;' };
    const first = await editMsg(call, context);
    const second = await editMsg(call, context);
    expect(first).not.toContain('AGAIN');
    expect(second).not.toContain('AGAIN');
  });

  it('disk mode (non-audit): an identical search-not-found repeat escalates', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('const keep = 1;\n') as never);
    const context = { editFailureSignatures: new Map<string, string>() };
    const call = { path: 'src/disk-notfound.ts', search: 'totally missing text', replace: 'new text' };

    const first = await editMsg(call, context);
    expect(first).toContain('search string not found');
    expect(first).not.toContain('AGAIN');

    const second = await editMsg(call, context);
    expect(second).toContain('AGAIN');
    vi.restoreAllMocks();
  });

  it('search-not-found: a 3rd identical repeat SUGGESTS a region — it never overwrites one', async () => {
    // This test used to assert the opposite: that a 20%-confidence fuzzy match
    // should overwrite `alpha zzzz zzzz zzzz` with `alpha beta gamma delta
    // epsilon`. That is nonsense, and it was the DESIGNED behaviour. Measured
    // over 1,700 real edits from 11 repositories, the matcher picks the wrong
    // region 30% of the time it commits — at ANY confidence threshold. It now
    // hands the candidate to the model instead of writing it.
    const context = { config: { agentMode: 'audit' } as never, editFailureSignatures: new Map<string, string>() };
    const fileContent = 'function foo() {\n  alpha zzzz zzzz zzzz zzzz;\n  return 1;\n}\n';
    await buf.write('src/loose.ts', fileContent, async () => undefined);
    const call = { path: 'src/loose.ts', search: 'totally missing text', replace: 'alpha beta gamma delta epsilon' };

    const first = await editMsg(call, context);
    expect(first).toContain('search string not found');

    const second = await editMsg(call, context);
    expect(second).toContain('AGAIN');

    const third = await editMsg(call, context);
    expect(third).toContain('closest matching region'); // the candidate, handed over
    expect(third).not.toContain('Auto-repaired');

    // The file is untouched. That is the whole point.
    expect(buf.read('src/loose.ts').content).toBe(fileContent);
  });

  it('disk mode: a 3rd identical repeat SUGGESTS a region and writes NOTHING', async () => {
    const { workspace } = await import('vscode');
    const fileContent = 'function foo() {\n  alpha zzzz zzzz zzzz zzzz;\n  return 1;\n}\n';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(fileContent) as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    writeSpy.mockClear();
    const context = { editFailureSignatures: new Map<string, string>() };
    const call = {
      path: 'src/disk-loose.ts',
      search: 'totally missing text',
      replace: 'alpha beta gamma delta epsilon',
    };

    await editMsg(call, context); // 1st
    await editMsg(call, context); // 2nd (AGAIN)
    const third = await editMsg(call, context); // 3rd — used to auto-repair to disk

    expect(third).toContain('closest matching region');
    expect(writeSpy).not.toHaveBeenCalled(); // NOTHING is written on a guess
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

    await editMsg(call, context); // 1st: normal hint
    const second = await editMsg(call, context); // 2nd: escalated, grep-preferred hint
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
        await expect(writeFile({ path: name, content: 'data' })).rejects.toThrow(
          /secrets or credentials.*not permitted to write/i,
        );
      });
    }

    it('allows write to a non-sensitive file', async () => {
      const { workspace } = await import('vscode');
      vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
      vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);
      const result = await writeMsg({ path: safeName, content: 'export {}' });
      expect(result).toContain('File written');
      vi.restoreAllMocks();
    });
  });

  describe('editFile rejects sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`blocks edit of ${name}`, async () => {
        const result = await editMsg({ path: name, search: 'x', replace: 'y' });
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

  // The write guards THROW now (a refused write must not read as a success to
  // the loop's error accounting). Capture either outcome for assertions.
  async function mockedWrite(input: Record<string, unknown>, context: Record<string, unknown>) {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    return writeFile(input, context).catch((e: Error) => e.message);
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
    // Refusals throw — capture the message so assertions read the same either way.
    return writeFile(input, context).catch((e: Error) => e.message);
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
    const result = await editMsg({ path: 'src/foo.ts', search: 'const y = 2;', replace: 'const y = 99;' }, context);

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
    const result = await editMsg({ path: 'src/foo.ts', search: 'same', replace: 'same' }, context);
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
    const result = await writeMsg({ path: 'src/bar.ts', content: newContent }, context);

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
    const result = await editMsg({ path: 'src/x.ts', search: 'old', replace: 'new' }, {});
    expect(result).toBe('File edited: src/x.ts');
    vi.restoreAllMocks();
  });
});

describe('path-validation rejections throw (never success-shaped strings)', () => {
  // v0.119 dogfood finding: validateFilePath errors were RETURNED as normal
  // tool output, so the executor recorded is_error=false — absolute-path and
  // traversal rejections looked like successful calls to every downstream
  // ledger (bounce-escalation streak resets, cycle detection, the completion
  // gate's read-verification). They must throw so is_error is honest.
  it('readFile rejects an absolute path', async () => {
    await expect(readFile({ path: '/etc/hosts' })).rejects.toThrow('absolute paths are not allowed');
  });

  it('readFile rejects path traversal', async () => {
    await expect(readFile({ path: '../outside.ts' })).rejects.toThrow('path traversal');
  });

  it('writeFile rejects an absolute path', async () => {
    await expect(writeFile({ path: '/tmp/x.ts', content: 'x' })).rejects.toThrow('absolute paths are not allowed');
  });
});

describe('inferred-edit structural guard (no silent file corruption)', () => {
  const original =
    '// Says hello to the given name.\n' +
    'export function greet(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n';

  beforeEach(() => {
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
  });

  it('SUGGESTS rather than applies when the search string does not match', async () => {
    // This case used to be gated by a delimiter-balance heuristic and then
    // APPLIED. Both halves were wrong: the heuristic false-refuses 8% of valid
    // TypeScript, and the fuzzy region it was gating is wrong 30% of the time.
    // Nothing is written on a guess now — the candidate region is handed to the
    // model to copy into `search`.
    const { workspace } = await import('vscode');
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    writeSpy.mockClear();

    const result = await editMsg({
      path: 'src/greeter.ts',
      search: 'function greet(name): string', // genuinely absent — forces the fuzzy path
      replace: 'function welcome(name: string): string { return `Hello, ${name}!`; }',
    });

    expect(result).toMatch(/closest matching region|search string not found/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('still applies a balanced inference (the legitimate fuzzy-match case)', async () => {
    // Whitespace-only mismatch: the replacement is a drop-in for the region
    // (same bracket balance), so the fuzzy path remains available.
    let written = '';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_uri, content) => {
      written = Buffer.from(content as Uint8Array).toString('utf-8');
    });

    const result = await editMsg({
      path: 'src/greeter.ts',
      search: '  return `Hello, ${name}!`;', // exact-match path
      replace: '  return `Hi, ${name}!`;',
    });

    expect(result).not.toMatch(/could not safely apply/i);
    expect(written).toContain('Hi, ${name}!');
    // Structure intact: export preserved, braces balanced.
    expect(written).toContain('export function greet');
    const opens = (written.match(/\{/g) || []).length;
    const closes = (written.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});

describe('exact-match token-boundary guard (no mid-token splicing)', () => {
  afterEach(() => vi.restoreAllMocks());
  const original =
    '// Says hello to the given name.\n' +
    'export function greet(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n';

  beforeEach(async () => {
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
  });

  it('refuses a search string that ends mid-identifier (live corruption repro)', async () => {
    // llama3.2 searched `greet(name: string): s` — ending inside `string` — and
    // replaced it with `welcome(name: string)`, producing the corrupted
    // `export function welcome(name: string)tring): string {`. Bracket balance
    // was preserved, so only a lexical guard catches this.
    const { workspace } = await import('vscode');
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    writeSpy.mockClear(); // earlier suites spy on writeFile without restoring; drop their history

    await expect(
      editFile({ path: 'src/greeter.ts', search: 'greet(name: string): s', replace: 'welcome(name: string)' }),
    ).rejects.toThrow(/middle of a word/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('still applies a clean token-aligned edit', async () => {
    const { workspace } = await import('vscode');
    let written = '';
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_uri, content) => {
      written = Buffer.from(content as Uint8Array).toString('utf-8');
    });

    const result = await editFile({
      path: 'src/greeter.ts',
      search: 'export function greet(name: string): string {',
      replace: 'export function welcome(name: string): string {',
    });

    expect(result).toContain('File edited');
    expect(written).toContain('export function welcome(name: string): string {');
    expect(written).toContain('return `Hello, ${name}!`;');
    expect((written.match(/\{/g) || []).length).toBe((written.match(/\}/g) || []).length);
  });
});

describe('already-applied detection (completion recognition)', () => {
  afterEach(() => vi.restoreAllMocks());

  const renamed =
    '// Says hello to the given name.\n' +
    'export function welcome(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n';

  beforeEach(async () => {
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(renamed) as never);
  });

  it('tells the model the change is ALREADY APPLIED instead of "search not found"', async () => {
    // Live v0.119 loop: llama3.2 renamed greet→welcome on iteration 1, verified
    // it, then re-sent the same rename. "search string not found" is true but
    // useless, so it kept editing until cycle detection bailed at iteration 9.
    const { workspace } = await import('vscode');
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    writeSpy.mockClear();

    const result = await editMsg({
      path: 'src/greeter.ts',
      search: 'function greet(name: string)',
      replace: 'function welcome(name: string)',
    });

    expect(result).toContain('already contains the result of this edit');
    expect(result).toMatch(/do NOT repeat this edit/i);
    expect(result).not.toContain('search string not found');
    expect(writeSpy).not.toHaveBeenCalled(); // it's a no-op, not a rewrite
  });

  it('does NOT fire on a half-finished rename — the old name is still present', async () => {
    const halfDone = 'export function welcome(n: string) {}\nexport const alias = greet;\n';
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(halfDone) as never);

    const result = await editMsg({
      path: 'src/a.ts',
      search: 'function greet(name: string)',
      replace: 'function welcome(name: string)',
    });

    // `greet` still lives in the file, so there IS work left — this must not be
    // reported as complete. (It falls through to the normal not-found/inference
    // path, whose own guards decide what happens next.)
    expect(result).not.toContain('already contains the result');
    expect(result).not.toMatch(/do NOT repeat this edit/i);
  });

  it('does NOT fire when the edit adds nothing new (pure deletion / no-op search)', async () => {
    const result = await editMsg({
      path: 'src/greeter.ts',
      search: 'totally absent text',
      replace: 'totally absent text',
    });
    expect(result).not.toContain('already contains the result');
  });
});

describe('success messages never carry retry guidance', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a successful edit is not prefixed with "you have not read this file" corrective text', async () => {
    // v0.119 dogfood clunk: the rename LANDED on iteration 1, but the success
    // message was prefixed with "[You have not read src/greeter.ts this turn.
    // … use the exact text from above as your search string — it must match
    // byte-for-byte]". That is guidance for a FAILED edit. The model read it as
    // "something is wrong", re-read the file, and re-issued the same edit.
    const original = 'export function greet(name: string): string {\n  return `hi`;\n}\n';
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);

    const result = await editMsg(
      {
        path: 'src/greeter.ts',
        search: 'export function greet(name: string): string {',
        replace: 'export function welcome(name: string): string {',
      },
      // filesReadThisTurn present but EMPTY → the file counts as unread.
      { filesReadThisTurn: new Set<string>() } as never,
    );

    expect(result).toContain('File edited');
    expect(result).not.toContain('You have not read');
    expect(result).not.toMatch(/use the exact text|search string/i);
  });
});

describe('missing-search recovery (live v0.119 JSDoc bug)', () => {
  afterEach(() => vi.restoreAllMocks());

  const current = '// Says hello.\nexport function welcome(name: string): string {\n  return `hi`;\n}\n';

  it('missing search: suggests the region and writes nothing unless the match is unambiguous', async () => {
    // Applying a GUESSED region is only safe when it is unambiguous (beats the
    // runner-up by APPLY_MARGIN distinctive words — zero wrong regions across
    // 1,700 real edits at that bar). A small file rarely clears it, so the model
    // gets the exact text to copy instead of a coin-flip rewrite.
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(current) as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    writeSpy.mockClear();

    const result = await editMsg({
      path: 'src/greeter.ts',
      replace: '/** Welcomes someone. */\nexport function welcome(name: string): string {',
    });

    expect(result).toMatch(/requires 'search'/);
    expect(result).toContain('Copy this into');
    expect(result).toContain('export function welcome'); // the literal current text
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('when inference is impossible, the error hands the model the exact text to copy', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(current) as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    writeSpy.mockClear();

    // Replacement shares no tokens with the file → nothing to infer from.
    const err = await editMsg({ path: 'src/greeter.ts', replace: 'zzz qqq vvv' });

    expect(err).toMatch(/requires 'search'/);
    expect(err).toContain('Copy this into');
    expect(err).toContain('export function welcome'); // the literal current text
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('write_file syntax guard (edit_file bypass)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses unparseable source that would clobber a clean file (live v0.119 JSDoc bypass)', async () => {
    // The model sidestepped edit_file and called write_file with
    // `@tsdoc \n\nfunction welcome(...)` — dropping `export`, writing a
    // non-comment, and destroying a clean file. Every guard lived in edit_file.
    const clean = 'export function welcome(name: string): string {\n  return `hi`;\n}\n';
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(clean) as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    const { __setParserForTests, __resetParserCache } = await import('./syntaxCheck.js');
    const broken = '@tsdoc \n\nfunction welcome(name: string): string {';
    __setParserForTests('typescript', {
      parse: (c: string) => ({
        rootNode:
          c === broken
            ? {
                type: 'program',
                hasError: true,
                startPosition: { row: 0, column: 0 },
                childCount: 1,
                child: () => ({
                  type: 'ERROR',
                  hasError: true,
                  startPosition: { row: 0, column: 0 },
                  childCount: 0,
                  child: () => null,
                }),
              }
            : {
                type: 'program',
                hasError: false,
                startPosition: { row: 0, column: 0 },
                childCount: 0,
                child: () => null,
              },
      }),
    } as never);
    writeSpy.mockClear();

    await expect(writeFile({ path: 'src/greeter.ts', content: broken })).rejects.toThrow(/unparseable|refused/i);
    expect(writeSpy).not.toHaveBeenCalled();
    __resetParserCache();
  });

  it('still writes valid source normally', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);

    const result = await writeFile({ path: 'src/new.ts', content: 'export const x = 1;\n' });
    expect(result).toContain('File written');
  });
});

describe('edit_file insertion (first-class add, not a restated anchor)', () => {
  afterEach(() => vi.restoreAllMocks());

  const original =
    '// Says hello to the given name.\n' +
    'export function welcome(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n';

  beforeEach(async () => {
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
  });

  it('insert_before adds text above the anchor and KEEPS the anchor (the live JSDoc task)', async () => {
    // Both qwen2.5-coder and llama3.2 failed this by sending only the comment in
    // `replace` — which means "delete the function, put a comment there".
    const { workspace } = await import('vscode');
    let written = '';
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_u, c) => {
      written = Buffer.from(c as Uint8Array).toString('utf-8');
    });

    const result = await editMsg({
      path: 'src/greeter.ts',
      search: 'export function welcome(name: string): string {',
      insert_before: '/**\n * Welcomes someone.\n * @param name - the person to greet\n */',
    });

    expect(result).toContain('File edited');
    expect(written).toContain('/**');
    expect(written).toContain('* @param name');
    expect(written).toContain('export function welcome(name: string): string {'); // anchor kept
    expect(written).toContain('return `Hello, ${name}!`;'); // body intact
    expect((written.match(/\{/g) || []).length).toBe((written.match(/\}/g) || []).length);
  });

  it('insert_after adds text below the anchor', async () => {
    const { workspace } = await import('vscode');
    let written = '';
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_u, c) => {
      written = Buffer.from(c as Uint8Array).toString('utf-8');
    });

    await editMsg({
      path: 'src/greeter.ts',
      search: '  return `Hello, ${name}!`;',
      insert_after: '  // greeting sent',
    });

    expect(written).toContain('// greeting sent');
    expect(written).toContain('export function welcome');
    expect((written.match(/\{/g) || []).length).toBe((written.match(/\}/g) || []).length);
  });

  it('rejects replace + insert together, and an insert with no anchor', async () => {
    const both = await editMsg({
      path: 'src/greeter.ts',
      search: 'x',
      replace: 'y',
      insert_before: 'z',
    });
    expect(both).toMatch(/both 'replace' and an insert/i);

    const noAnchor = await editMsg({ path: 'src/greeter.ts', insert_before: '/** hi */' });
    expect(noAnchor).toMatch(/needs 'search'/i);
  });
});

describe('duplicated-tail repair (over-specified replace)', () => {
  afterEach(() => vi.restoreAllMocks());

  const original =
    '// Says hello to the given name.\n' +
    'export function welcome(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n';

  it('trims a replace that restates the block body, applying the edit as an insertion', async () => {
    // Exactly what qwen2.5-coder sent for "add a JSDoc comment": search names
    // the HEADER, replace restates header AND body. Substituting duplicates the
    // body and the file stops parsing — so the whole task failed with the file
    // untouched, three attempts running.
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
    let written = '';
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_u, c) => {
      written = Buffer.from(c as Uint8Array).toString('utf-8');
    });

    const result = await editMsg({
      path: 'src/greeter.ts',
      search: 'export function welcome(name: string): string {',
      replace:
        '/**\n * Says hello.\n * @param name - the person\n */\n' +
        'export function welcome(name: string): string {\n  return `Hello, ${name}!`;\n}',
    });

    expect(result).toContain('File edited');
    expect(result).toMatch(/redundant tail was trimmed/i);

    // The JSDoc landed, the function survives EXACTLY once, and it still parses.
    expect(written).toContain('* @param name');
    expect(written.match(/export function welcome/g)).toHaveLength(1);
    expect(written.match(/return `Hello/g)).toHaveLength(1);
    expect((written.match(/\{/g) || []).length).toBe((written.match(/\}/g) || []).length);
  });

  it('never rewrites an edit that was already valid', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(settings, 'getConfig').mockReturnValue({ agentMode: 'agent' } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(original) as never);
    let written = '';
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_u, c) => {
      written = Buffer.from(c as Uint8Array).toString('utf-8');
    });

    const result = await editMsg({
      path: 'src/greeter.ts',
      search: 'export function welcome(name: string): string {',
      replace: 'export function greet(name: string): string {',
    });

    expect(result).not.toMatch(/redundant tail/i);
    expect(written).toContain('export function greet(name: string): string {');
  });
});

// ---------------------------------------------------------------------------
// read_file — recovering from a wrong path.
//
// The live failure (T2 smoke, qwen2.5-coder): the model asked for src/helpers.ts,
// which does not exist. Our error told it to "use search_files". It did exactly
// that — search_files("*helpers*") — got "No files found", and gave up. src/utils.ts,
// the file it actually needed, was one directory listing away.
//
// Searching for a filename the model INVENTED is the one query guaranteed to return
// nothing. We know what is in the directory; the error has to say so, and point at
// CONTENT search rather than name search.
// ---------------------------------------------------------------------------

describe('readFile — file-not-found recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the real directory contents instead of sending the model to search for a name it invented', async () => {
    const { workspace, Uri } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    // No exact basename match anywhere (helpers.ts does not exist) …
    const findFiles = vi.spyOn(workspace, 'findFiles') as unknown as ReturnType<typeof vi.fn>;
    findFiles.mockImplementation(async (glob: string) =>
      glob === 'src/*' ? [Uri.file('/ws/src/utils.ts'), Uri.file('/ws/src/index.ts')] : [],
    );
    vi.spyOn(workspace, 'asRelativePath').mockImplementation(((u: { fsPath: string }) =>
      u.fsPath.replace('/ws/', '')) as never);

    const err = await readFile({ path: 'src/helpers.ts' }).catch((e: Error) => e.message);
    expect(err).toContain('No file named "helpers.ts" exists');
    expect(err).toContain('src/utils.ts'); // the file it actually needs
    expect(err).toMatch(/search by CONTENT/i); // and not by the invented filename
  });

  it('still offers an exact basename match from another directory when one exists', async () => {
    const { workspace, Uri } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const findFiles = vi.spyOn(workspace, 'findFiles') as unknown as ReturnType<typeof vi.fn>;
    findFiles.mockImplementation(async (glob: string) =>
      glob === '**/utils.ts' ? [Uri.file('/ws/src/lib/utils.ts')] : [],
    );
    vi.spyOn(workspace, 'asRelativePath').mockImplementation(((u: { fsPath: string }) =>
      u.fsPath.replace('/ws/', '')) as never);

    const err = await readFile({ path: 'utils.ts' }).catch((e: Error) => e.message);
    expect(err).toContain('Did you mean');
    expect(err).toContain('src/lib/utils.ts');
  });
});
