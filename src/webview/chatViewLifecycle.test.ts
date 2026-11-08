import { describe, it, expect } from 'vitest';
import {
  buildUiSettingsMessage,
  buildAgentModeMessage,
  buildActiveFileMessage,
  buildThinkingStateMessage,
  UI_CONFIG_KEYS,
  THINKING_CONFIG_KEYS,
} from './chatViewLifecycle.js';

describe('buildUiSettingsMessage', () => {
  it('returns a uiSettings command with all fields', () => {
    const msg = buildUiSettingsMessage({
      chatDensity: 'compact',
      chatFontSize: 14,
      chatAccentColor: '#ff0000',
      voiceEnabled: false,
    });
    expect(msg.command).toBe('uiSettings');
    expect(msg.chatDensity).toBe('compact');
    expect(msg.chatFontSize).toBe(14);
    expect(msg.chatAccentColor).toBe('#ff0000');
  });

  it('accepts all three density values', () => {
    for (const density of ['compact', 'normal', 'comfortable'] as const) {
      const msg = buildUiSettingsMessage({
        chatDensity: density,
        chatFontSize: 13,
        chatAccentColor: '',
        voiceEnabled: false,
      });
      expect(msg.chatDensity).toBe(density);
    }
  });
});

describe('buildAgentModeMessage', () => {
  it('returns a setAgentMode command with mode and customModes', () => {
    const msg = buildAgentModeMessage({
      agentMode: 'autonomous',
      customModes: [{ name: 'My Mode', description: 'does stuff' }],
    });
    expect(msg.command).toBe('setAgentMode');
    expect(msg.agentMode).toBe('autonomous');
    expect(msg.customModes).toEqual([{ name: 'My Mode', description: 'does stuff' }]);
  });

  it('handles empty customModes array', () => {
    const msg = buildAgentModeMessage({ agentMode: 'cautious', customModes: [] });
    expect(msg.customModes).toHaveLength(0);
  });
});

describe('buildActiveFileMessage', () => {
  it('returns fileName as basename and full filePath for an absolute path', () => {
    const msg = buildActiveFileMessage('/home/user/project/src/foo.ts');
    expect(msg.command).toBe('activeFileChanged');
    expect(msg.fileName).toBe('foo.ts');
    expect(msg.filePath).toBe('/home/user/project/src/foo.ts');
  });

  it('returns undefined fileName when filePath is undefined', () => {
    const msg = buildActiveFileMessage(undefined);
    expect(msg.command).toBe('activeFileChanged');
    expect(msg.fileName).toBeUndefined();
    expect(msg.filePath).toBeUndefined();
  });

  it('handles a filename with no directory', () => {
    const msg = buildActiveFileMessage('index.js');
    expect(msg.fileName).toBe('index.js');
  });
});

describe('UI_CONFIG_KEYS', () => {
  it('contains the three UI-relevant config keys', () => {
    expect(UI_CONFIG_KEYS).toContain('sidecar.chatDensity');
    expect(UI_CONFIG_KEYS).toContain('sidecar.chatFontSize');
    expect(UI_CONFIG_KEYS).toContain('sidecar.chatAccentColor');
  });

  it('has exactly four entries', () => {
    expect(UI_CONFIG_KEYS).toHaveLength(4);
  });
});

describe('buildThinkingStateMessage (header Thinking switch)', () => {
  it('shows the switch only when the active backend is Ollama', () => {
    const msg = (baseUrl: string, provider: string) =>
      buildThinkingStateMessage({ baseUrl, provider, ollamaDisableThinking: false } as never);
    expect(msg('http://localhost:11434', 'auto').thinkingSupported).toBe(true);
    expect(msg('http://gpu-box:8080', 'ollama').thinkingSupported).toBe(true);
    expect(msg('https://api.anthropic.com', 'auto').thinkingSupported).toBe(false);
    expect(msg('http://localhost:11435', 'auto').thinkingSupported).toBe(false);
    expect(msg('http://localhost:11434', 'openai').thinkingSupported).toBe(false);
  });

  it('switch on means disableThinking is false', () => {
    const base = { baseUrl: 'http://localhost:11434', provider: 'auto' } as const;
    expect(buildThinkingStateMessage({ ...base, ollamaDisableThinking: false })).toEqual({
      command: 'thinkingState',
      thinkingSupported: true,
      thinkingEnabled: true,
    });
    expect(buildThinkingStateMessage({ ...base, ollamaDisableThinking: true }).thinkingEnabled).toBe(false);
  });

  it('re-syncs on the setting itself and on a backend switch', () => {
    expect(THINKING_CONFIG_KEYS).toEqual(['sidecar.ollama.disableThinking', 'sidecar.baseUrl', 'sidecar.provider']);
  });
});
