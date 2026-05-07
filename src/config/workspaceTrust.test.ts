import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace, window } from 'vscode';
import { checkWorkspaceConfigTrust, resetWorkspaceTrust } from './workspaceTrust.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetWorkspaceTrust();
});

describe('checkWorkspaceConfigTrust — no workspace config', () => {
  it('returns "trusted" immediately when inspect returns no workspaceValue', async () => {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      inspect: () => ({ workspaceValue: undefined }),
    } as never);

    const result = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(result).toBe('trusted');
  });

  it('does not prompt the user when there is no workspace config', async () => {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      inspect: () => ({ workspaceValue: undefined }),
    } as never);
    const warnSpy = vi.spyOn(window, 'showWarningMessage');

    await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "trusted" when workspaceValue is an empty object', async () => {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      inspect: () => ({ workspaceValue: {} }),
    } as never);

    const result = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(result).toBe('trusted');
  });
});

describe('checkWorkspaceConfigTrust — user prompt', () => {
  function withWorkspaceConfig() {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      inspect: () => ({ workspaceValue: { onSave: 'echo hi' } }),
    } as never);
  }

  it('returns "blocked" when the user picks Block', async () => {
    withWorkspaceConfig();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);

    const result = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(result).toBe('blocked');
  });

  it('returns "trusted" when the user picks Allow', async () => {
    withWorkspaceConfig();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Allow' as never);

    const result = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(result).toBe('trusted');
  });

  it('returns "trusted" when the user dismisses the dialog (undefined)', async () => {
    withWorkspaceConfig();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const result = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(result).toBe('trusted');
  });
});

describe('checkWorkspaceConfigTrust — session cache', () => {
  it('prompts only once and returns the cached answer on subsequent calls', async () => {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      inspect: () => ({ workspaceValue: { onSave: 'echo hi' } }),
    } as never);
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);

    const first = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    const second = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');

    expect(first).toBe('blocked');
    expect(second).toBe('blocked');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('caches per section — different sections are independent', async () => {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      inspect: (key: string) => (key === 'hooks' ? { workspaceValue: { onSave: 'x' } } : { workspaceValue: undefined }),
    } as never);
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);

    const hooksResult = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    const mcpResult = await checkWorkspaceConfigTrust('mcpServers', 'Allow MCP?');

    expect(hooksResult).toBe('blocked');
    expect(mcpResult).toBe('trusted'); // no workspace config for mcpServers
  });
});
