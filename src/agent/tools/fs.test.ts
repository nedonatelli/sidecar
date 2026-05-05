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
    expect(result).toContain('Error: Search text not found');
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
