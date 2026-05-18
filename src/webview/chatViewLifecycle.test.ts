import { describe, it, expect } from 'vitest';
import {
  buildUiSettingsMessage,
  buildAgentModeMessage,
  buildActiveFileMessage,
  UI_CONFIG_KEYS,
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
