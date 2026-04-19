import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHook } from './hookRunner.js';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../config/workspaceTrust.js', () => ({
  checkWorkspaceConfigTrust: vi.fn().mockResolvedValue('trusted'),
}));

vi.mock('../securityScanner.js', () => ({
  redactSecrets: vi.fn((s: string) => s.replace(/secret-\w+/g, '[REDACTED]')),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { getConfig } from '../../config/settings.js';
import { checkWorkspaceConfigTrust } from '../../config/workspaceTrust.js';
import { exec } from 'child_process';

const mockedGetConfig = vi.mocked(getConfig);
const mockedTrust = vi.mocked(checkWorkspaceConfigTrust);
const mockedExec = vi.mocked(exec);

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function mockExecSuccess() {
  mockedExec.mockImplementation((_cmd, _opts, fn: unknown) => {
    (fn as ExecCb)(null, '', '');
    return {} as ReturnType<typeof exec>;
  });
}

function mockExecError(message: string) {
  mockedExec.mockImplementation((_cmd, _opts, fn: unknown) => {
    (fn as ExecCb)(new Error(message), '', message);
    return {} as ReturnType<typeof exec>;
  });
}

function mockConfig(hooks: Record<string, unknown> = {}) {
  mockedGetConfig.mockReturnValue({ hooks, toolPermissions: {} } as ReturnType<typeof getConfig>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTrust.mockResolvedValue('trusted');
});

describe('runHook', () => {
  it('returns undefined when no hook is configured for the tool', async () => {
    mockConfig({});
    const result = await runHook('pre', 'read_file', {});
    expect(result).toBeUndefined();
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('returns undefined when no global hook and no per-tool hook', async () => {
    mockConfig({ write_file: { post: 'echo done' } });
    const result = await runHook('pre', 'read_file', {});
    expect(result).toBeUndefined();
  });

  it('runs a per-tool pre hook and returns undefined on success', async () => {
    mockConfig({ write_file: { pre: 'lint check' } });
    mockExecSuccess();
    const result = await runHook('pre', 'write_file', { path: 'src/foo.ts' });
    expect(result).toBeUndefined();
    expect(mockedExec).toHaveBeenCalledOnce();
  });

  it('falls back to the global * hook when no per-tool hook matches', async () => {
    mockConfig({ '*': { pre: 'audit-log' } });
    mockExecSuccess();
    const result = await runHook('pre', 'run_command', { command: 'npm test' });
    expect(result).toBeUndefined();
    expect(mockedExec).toHaveBeenCalledOnce();
  });

  it('returns the error message when a pre hook fails', async () => {
    mockConfig({ write_file: { pre: 'exit 1' } });
    mockExecError('Command failed: exit 1');
    const result = await runHook('pre', 'write_file', {});
    expect(result).toMatch(/Command failed/);
  });

  it('returns undefined when a post hook fails (post-hooks only warn)', async () => {
    mockConfig({ write_file: { post: 'notify' } });
    mockExecError('notify failed');
    const result = await runHook('post', 'write_file', {});
    expect(result).toBeUndefined();
  });

  it('returns undefined without running hook when trust is blocked', async () => {
    mockConfig({ write_file: { pre: 'malicious' } });
    mockedTrust.mockResolvedValue('blocked');
    const result = await runHook('pre', 'write_file', {});
    expect(result).toBeUndefined();
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('sets SIDECAR_TOOL env var to the tool name', async () => {
    mockConfig({ read_file: { pre: 'check' } });
    let capturedEnv: Record<string, string> | undefined;
    mockedExec.mockImplementation((_cmd, opts, fn: unknown) => {
      capturedEnv = (opts as { env?: Record<string, string> }).env;
      (fn as ExecCb)(null, '', '');
      return {} as ReturnType<typeof exec>;
    });
    await runHook('pre', 'read_file', { path: 'src/main.ts' });
    expect(capturedEnv?.SIDECAR_TOOL).toBe('read_file');
  });

  it('redacts secrets from SIDECAR_INPUT', async () => {
    mockConfig({ read_file: { pre: 'log' } });
    let capturedEnv: Record<string, string> | undefined;
    mockedExec.mockImplementation((_cmd, opts, fn: unknown) => {
      capturedEnv = (opts as { env?: Record<string, string> }).env;
      (fn as ExecCb)(null, '', '');
      return {} as ReturnType<typeof exec>;
    });
    await runHook('pre', 'read_file', { content: 'secret-abc123' });
    expect(capturedEnv?.SIDECAR_INPUT).toContain('[REDACTED]');
    expect(capturedEnv?.SIDECAR_INPUT).not.toContain('secret-abc123');
  });

  it('sets SIDECAR_OUTPUT env var for post hooks', async () => {
    mockConfig({ write_file: { post: 'audit' } });
    let capturedEnv: Record<string, string> | undefined;
    mockedExec.mockImplementation((_cmd, opts, fn: unknown) => {
      capturedEnv = (opts as { env?: Record<string, string> }).env;
      (fn as ExecCb)(null, '', '');
      return {} as ReturnType<typeof exec>;
    });
    await runHook('post', 'write_file', {}, 'written 42 bytes');
    expect(capturedEnv?.SIDECAR_OUTPUT).toBe('written 42 bytes');
  });
});
