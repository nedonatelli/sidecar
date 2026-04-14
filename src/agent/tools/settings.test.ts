import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above imports at transform time, so any variables
// the factory closes over must also be hoisted — use `vi.hoisted` for
// the mock functions, otherwise the factory runs before the `const`
// declarations and hits a temporal-dead-zone error.
const { mockGet, mockUpdate, mockApplyBackendProfile } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockApplyBackendProfile: vi.fn(),
}));

// Minimal vscode mock — only the surfaces the settings tools touch.
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: mockGet,
      update: mockUpdate,
    }),
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
}));

// Fake profile list + applyBackendProfile — we don't want to drag in
// real SecretStorage bootstrapping for a unit test.
vi.mock('../../config/settings.js', () => ({
  BUILT_IN_BACKEND_PROFILES: [
    {
      id: 'local-ollama',
      name: 'Local Ollama',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      defaultModel: 'qwen2.5-coder:7b',
      secretKey: null,
    },
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-6',
      secretKey: 'sidecar.profileKey.anthropic',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      defaultModel: 'gpt-4o',
      secretKey: 'sidecar.profileKey.openai',
    },
    {
      id: 'kickstand',
      name: 'Kickstand',
      provider: 'kickstand',
      baseUrl: 'http://localhost:11435',
      defaultModel: '',
      secretKey: 'sidecar.profileKey.kickstand',
    },
  ],
  applyBackendProfile: mockApplyBackendProfile,
}));

import { switchBackend, getSetting, updateSetting, getDeniedSettingKeys } from './settings.js';

describe('settings tools', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockUpdate.mockReset();
    mockApplyBackendProfile.mockReset();
  });

  // -------------------------------------------------------------------------
  // switch_backend
  // -------------------------------------------------------------------------
  describe('switch_backend', () => {
    it('resolves a known profile by id and applies it', async () => {
      mockApplyBackendProfile.mockResolvedValue({
        status: 'applied',
        message: 'Switched to Anthropic Claude (claude-sonnet-4-6)',
      });
      const out = await switchBackend({ profile: 'anthropic' });
      expect(out).toBe('Switched to Anthropic Claude (claude-sonnet-4-6)');
      expect(mockApplyBackendProfile).toHaveBeenCalledTimes(1);
      expect(mockApplyBackendProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'anthropic' }));
    });

    it('passes through missing-key status so the agent can tell the user to set the key', async () => {
      mockApplyBackendProfile.mockResolvedValue({
        status: 'missing-key',
        message:
          'Switched to Anthropic Claude, but no API key is stored for this profile yet. Run "SideCar: Set API Key" to set it, then switch again.',
      });
      const out = await switchBackend({ profile: 'anthropic' });
      expect(out).toContain('no API key is stored');
      expect(out).toContain('Set API Key');
    });

    it('rejects unknown profile ids and lists known profiles', async () => {
      const out = await switchBackend({ profile: 'bogus-backend' });
      expect(out).toContain('Unknown backend profile');
      expect(out).toContain('local-ollama');
      expect(out).toContain('anthropic');
      expect(out).toContain('openai');
      expect(out).toContain('kickstand');
      expect(mockApplyBackendProfile).not.toHaveBeenCalled();
    });

    it('resolves the openai profile', async () => {
      mockApplyBackendProfile.mockResolvedValue({
        status: 'applied',
        message: 'Switched to OpenAI (gpt-4o)',
      });
      const out = await switchBackend({ profile: 'openai' });
      expect(out).toBe('Switched to OpenAI (gpt-4o)');
      expect(mockApplyBackendProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai' }));
    });

    it('rejects empty profile id', async () => {
      const out = await switchBackend({ profile: '' });
      expect(out).toContain('profile id is required');
      expect(mockApplyBackendProfile).not.toHaveBeenCalled();
    });

    it('handles applyBackendProfile throwing', async () => {
      mockApplyBackendProfile.mockRejectedValue(new Error('SecretStorage not initialized'));
      const out = await switchBackend({ profile: 'anthropic' });
      expect(out).toContain('Failed to switch backend');
      expect(out).toContain('SecretStorage not initialized');
    });
  });

  // -------------------------------------------------------------------------
  // get_setting
  // -------------------------------------------------------------------------
  describe('get_setting', () => {
    it('returns the current value formatted as JSON', async () => {
      mockGet.mockReturnValue('compact');
      const out = await getSetting({ key: 'chatDensity' });
      expect(out).toBe('sidecar.chatDensity = "compact"');
    });

    it('handles numeric values', async () => {
      mockGet.mockReturnValue(20);
      const out = await getSetting({ key: 'dailyBudget' });
      expect(out).toBe('sidecar.dailyBudget = 20');
    });

    it('handles boolean values', async () => {
      mockGet.mockReturnValue(true);
      const out = await getSetting({ key: 'enableMermaid' });
      expect(out).toBe('sidecar.enableMermaid = true');
    });

    it('handles dotted namespace keys like jsDocSync.enabled', async () => {
      mockGet.mockReturnValue(false);
      const out = await getSetting({ key: 'jsDocSync.enabled' });
      expect(out).toBe('sidecar.jsDocSync.enabled = false');
    });

    it('reports not-configured when value is undefined', async () => {
      mockGet.mockReturnValue(undefined);
      const out = await getSetting({ key: 'doesNotExist' });
      expect(out).toContain('not configured');
    });

    it('refuses to read apiKey', async () => {
      const out = await getSetting({ key: 'apiKey' });
      expect(out).toContain('secret');
      expect(out).toContain('SecretStorage');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('refuses to read fallbackApiKey', async () => {
      const out = await getSetting({ key: 'fallbackApiKey' });
      expect(out).toContain('secret');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('rejects empty key', async () => {
      const out = await getSetting({ key: '' });
      expect(out).toContain('key is required');
    });
  });

  // -------------------------------------------------------------------------
  // update_setting
  // -------------------------------------------------------------------------
  describe('update_setting', () => {
    it('writes an allowed key to global (user) scope', async () => {
      mockUpdate.mockResolvedValue(undefined);
      const out = await updateSetting({ key: 'dailyBudget', value: 20 });
      expect(mockUpdate).toHaveBeenCalledWith('dailyBudget', 20, 1); // ConfigurationTarget.Global === 1
      expect(out).toContain('Updated sidecar.dailyBudget = 20');
      expect(out).toContain('persistent');
    });

    it('handles dotted namespace keys like promptPruning.enabled', async () => {
      mockUpdate.mockResolvedValue(undefined);
      const out = await updateSetting({ key: 'promptPruning.enabled', value: false });
      expect(mockUpdate).toHaveBeenCalledWith('promptPruning.enabled', false, 1);
      expect(out).toContain('Updated sidecar.promptPruning.enabled');
    });

    it('refuses every key on the security denylist', async () => {
      for (const k of getDeniedSettingKeys()) {
        mockUpdate.mockReset();
        const out = await updateSetting({ key: k, value: 'anything' });
        expect(out).toContain('security denylist');
        expect(mockUpdate).not.toHaveBeenCalled();
      }
    });

    it('blocks secrets specifically', async () => {
      for (const k of ['apiKey', 'fallbackApiKey']) {
        const out = await updateSetting({ key: k, value: 'sk-leaked' });
        expect(out).toContain('denylist');
      }
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('blocks backend identity keys — must use switch_backend', async () => {
      for (const k of ['baseUrl', 'provider', 'fallbackBaseUrl', 'delegateTask.workerBaseUrl']) {
        const out = await updateSetting({ key: k, value: 'https://attacker.example' });
        expect(out).toContain('denylist');
      }
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('blocks self-escalation keys (tool permissions, custom tools/modes, MCP, hooks)', async () => {
      for (const k of [
        'toolPermissions',
        'customTools',
        'customModes',
        'mcpServers',
        'hooks',
        'eventHooks',
        'scheduledTasks',
      ]) {
        const out = await updateSetting({ key: k, value: {} });
        expect(out).toContain('denylist');
      }
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('blocks exfiltration and base-prompt override keys', async () => {
      for (const k of ['outboundAllowlist', 'systemPrompt', 'pinnedContext', 'workspaceRoots']) {
        const out = await updateSetting({ key: k, value: [] });
        expect(out).toContain('denylist');
      }
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects missing value (undefined)', async () => {
      const out = await updateSetting({ key: 'chatDensity', value: undefined });
      expect(out).toContain('value is required');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('accepts explicit null values (for clearable settings)', async () => {
      mockUpdate.mockResolvedValue(undefined);
      const out = await updateSetting({ key: 'chatAccentColor', value: null });
      expect(mockUpdate).toHaveBeenCalledWith('chatAccentColor', null, 1);
      expect(out).toContain('Updated sidecar.chatAccentColor');
    });

    it('rejects empty key', async () => {
      const out = await updateSetting({ key: '', value: true });
      expect(out).toContain('key is required');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns an error message when cfg.update throws', async () => {
      mockUpdate.mockRejectedValue(new Error('workspace trust revoked'));
      const out = await updateSetting({ key: 'chatDensity', value: 'normal' });
      expect(out).toContain('Failed to update sidecar.chatDensity');
      expect(out).toContain('workspace trust revoked');
    });
  });

  // -------------------------------------------------------------------------
  // Denylist shape — pin the exact set so adding a new security-sensitive
  // setting must be a deliberate, test-breaking change.
  // -------------------------------------------------------------------------
  describe('denylist shape', () => {
    it('contains exactly the expected keys', () => {
      const denied = [...getDeniedSettingKeys()].sort();
      expect(denied).toEqual(
        [
          'apiKey',
          'baseUrl',
          'customModes',
          'customTools',
          'delegateTask.maxIterations',
          'delegateTask.workerBaseUrl',
          'eventHooks',
          'fallbackApiKey',
          'fallbackBaseUrl',
          'hooks',
          'mcpServers',
          'outboundAllowlist',
          'pinnedContext',
          'provider',
          'scheduledTasks',
          'systemPrompt',
          'toolPermissions',
          'workspaceRoots',
        ].sort(),
      );
    });
  });
});
