import { describe, it, expect } from 'vitest';
import { isLocalOllama, isAnthropic, detectProvider, getConfig } from './settings.js';

describe('isLocalOllama', () => {
  it('returns true for http://localhost:11434', () => {
    expect(isLocalOllama('http://localhost:11434')).toBe(true);
  });

  it('returns true for http://127.0.0.1:11434', () => {
    expect(isLocalOllama('http://127.0.0.1:11434')).toBe(true);
  });

  it('returns true with trailing path', () => {
    expect(isLocalOllama('http://localhost:11434/v1')).toBe(true);
  });

  it('returns true with trailing slash', () => {
    expect(isLocalOllama('http://localhost:11434/')).toBe(true);
  });

  it('returns false for Anthropic API', () => {
    expect(isLocalOllama('https://api.anthropic.com')).toBe(false);
  });

  it('returns false for other remote URLs', () => {
    expect(isLocalOllama('https://my-ollama-server.example.com:11434')).toBe(false);
  });

  it('returns false for localhost on a different port', () => {
    expect(isLocalOllama('http://localhost:8080')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLocalOllama('')).toBe(false);
  });
});

describe('isAnthropic', () => {
  it('returns true for api.anthropic.com', () => {
    expect(isAnthropic('https://api.anthropic.com')).toBe(true);
  });

  it('returns false for localhost', () => {
    expect(isAnthropic('http://localhost:11434')).toBe(false);
  });

  it('returns false for other URLs', () => {
    expect(isAnthropic('http://localhost:8080')).toBe(false);
  });
});

describe('detectProvider', () => {
  it('returns explicit provider when not auto', () => {
    expect(detectProvider('http://anything.com', 'openai')).toBe('openai');
    expect(detectProvider('http://anything.com', 'anthropic')).toBe('anthropic');
    expect(detectProvider('http://anything.com', 'ollama')).toBe('ollama');
  });

  it('auto-detects ollama from localhost:11434', () => {
    expect(detectProvider('http://localhost:11434', 'auto')).toBe('ollama');
  });

  it('auto-detects anthropic from anthropic.com', () => {
    expect(detectProvider('https://api.anthropic.com', 'auto')).toBe('anthropic');
  });

  it('defaults to openai for unknown URLs', () => {
    expect(detectProvider('http://localhost:1234', 'auto')).toBe('openai');
    expect(detectProvider('https://my-vllm-server.com', 'auto')).toBe('openai');
  });
});

describe('getConfig', () => {
  it('returns an object with all expected keys', () => {
    const config = getConfig();
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('provider');
    expect(config).toHaveProperty('systemPrompt');
    expect(config).toHaveProperty('baseUrl');
    expect(config).toHaveProperty('apiKey');
    expect(config).toHaveProperty('includeActiveFile');
    expect(config).toHaveProperty('planMode');
    expect(config).toHaveProperty('agentMode');
    expect(config).toHaveProperty('agentMaxIterations');
    expect(config).toHaveProperty('agentMaxTokens');
    expect(config).toHaveProperty('enableInlineCompletions');
    expect(config).toHaveProperty('completionModel');
    expect(config).toHaveProperty('completionMaxTokens');
    expect(config).toHaveProperty('completionDebounceMs');
    expect(config).toHaveProperty('toolPermissions');
    expect(config).toHaveProperty('hooks');
    expect(config).toHaveProperty('eventHooks');
    expect(config).toHaveProperty('scheduledTasks');
    expect(config).toHaveProperty('customTools');
    expect(config).toHaveProperty('mcpServers');
    expect(config).toHaveProperty('pinnedContext');
    expect(config).toHaveProperty('autoFixOnFailure');
    expect(config).toHaveProperty('autoFixMaxRetries');
    expect(config).toHaveProperty('fetchUrlContext');
  });

  it('returns correct defaults from mock configuration', () => {
    const config = getConfig();
    expect(config.model).toBe('qwen3-coder:30b');
    expect(config.baseUrl).toBe('http://localhost:11434');
    expect(config.apiKey).toBe('ollama');
    expect(config.agentMode).toBe('cautious');
    expect(config.agentMaxIterations).toBe(25);
    expect(config.agentMaxTokens).toBe(100000);
    expect(config.planMode).toBe(false);
    expect(config.enableInlineCompletions).toBe(false);
    expect(config.completionMaxTokens).toBe(256);
    expect(config.completionDebounceMs).toBe(300);
    expect(config.provider).toBe('auto');
    expect(config.pinnedContext).toEqual([]);
    expect(config.autoFixOnFailure).toBe(false);
    expect(config.autoFixMaxRetries).toBe(3);
    expect(config.fetchUrlContext).toBe(true);
  });

  it('returns typed object (not undefined values)', () => {
    const config = getConfig();
    for (const [key, value] of Object.entries(config)) {
      expect(value, `config.${key} should not be undefined`).not.toBeUndefined();
    }
  });
});
