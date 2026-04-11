import { describe, it, expect } from 'vitest';
import {
  isLocalOllama,
  isAnthropic,
  isKickstand,
  detectProvider,
  getConfig,
  clampMin,
  readKickstandToken,
  estimateCost,
} from './settings.js';

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

describe('isKickstand', () => {
  it('returns true for localhost:11435', () => {
    expect(isKickstand('http://localhost:11435')).toBe(true);
    expect(isKickstand('http://127.0.0.1:11435')).toBe(true);
  });

  it('returns false for other ports', () => {
    expect(isKickstand('http://localhost:11434')).toBe(false);
    expect(isKickstand('http://localhost:8080')).toBe(false);
  });

  it('returns false for other URLs', () => {
    expect(isKickstand('https://api.anthropic.com')).toBe(false);
    expect(isKickstand('http://localhost:1234')).toBe(false);
  });
});

describe('detectProvider', () => {
  it('returns explicit provider when not auto', () => {
    expect(detectProvider('http://anything.com', 'openai')).toBe('openai');
    expect(detectProvider('http://anything.com', 'anthropic')).toBe('anthropic');
    expect(detectProvider('http://anything.com', 'ollama')).toBe('ollama');
    expect(detectProvider('http://anything.com', 'kickstand')).toBe('kickstand');
  });

  it('auto-detects ollama from localhost:11434', () => {
    expect(detectProvider('http://localhost:11434', 'auto')).toBe('ollama');
  });

  it('auto-detects anthropic from anthropic.com', () => {
    expect(detectProvider('https://api.anthropic.com', 'auto')).toBe('anthropic');
  });

  it('auto-detects kickstand from localhost:11435', () => {
    expect(detectProvider('http://localhost:11435', 'auto')).toBe('kickstand');
    expect(detectProvider('http://127.0.0.1:11435', 'auto')).toBe('kickstand');
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
    expect(config.agentMaxIterations).toBe(50);
    expect(config.agentMaxTokens).toBe(100000);
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

describe('clampMin', () => {
  it('returns the value when above minimum', () => {
    expect(clampMin(50, 1, 25)).toBe(50);
  });

  it('clamps to minimum when value is too low', () => {
    expect(clampMin(-5, 1, 25)).toBe(1);
    expect(clampMin(0, 1, 25)).toBe(1);
  });

  it('returns fallback for undefined', () => {
    expect(clampMin(undefined, 1, 25)).toBe(25);
  });

  it('returns fallback for NaN', () => {
    expect(clampMin(NaN, 1, 25)).toBe(25);
  });

  it('returns fallback for non-number types', () => {
    // Simulate bad config value cast
    expect(clampMin('hello' as unknown as number, 1, 25)).toBe(25);
  });

  it('allows zero when min is zero', () => {
    expect(clampMin(0, 0, 120)).toBe(0);
  });

  it('returns exact minimum when value equals minimum', () => {
    expect(clampMin(1, 1, 25)).toBe(1);
  });
});

describe('readKickstandToken', () => {
  it('returns a non-empty string', () => {
    const token = readKickstandToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});

describe('estimateCost', () => {
  it('returns null for unknown models', () => {
    expect(estimateCost('llama3:latest', 1000, 500)).toBeNull();
  });

  it('estimates cost for Claude Opus', () => {
    const cost = estimateCost('claude-opus-4-6', 1000, 500);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
    // 1000 input * $15/M + 500 output * $75/M = 0.015 + 0.0375 = 0.0525
    expect(cost!).toBeCloseTo(0.0525, 3);
  });

  it('estimates cost for Claude Sonnet', () => {
    const cost = estimateCost('claude-sonnet-4-6', 1000, 500);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('estimates cost for Claude Haiku', () => {
    const cost = estimateCost('claude-haiku-4-5', 1000, 500);
    expect(cost).not.toBeNull();
  });

  it('matches partial model names', () => {
    // Model strings from providers may include prefixes
    const cost = estimateCost('anthropic/claude-opus-4-6', 1000, 500);
    expect(cost).not.toBeNull();
  });
});

describe('getConfig semantic search settings', () => {
  it('includes enableSemanticSearch defaulting to true', () => {
    const config = getConfig();
    expect(config.enableSemanticSearch).toBe(true);
  });

  it('includes semanticSearchWeight defaulting to 0.6', () => {
    const config = getConfig();
    expect(config.semanticSearchWeight).toBeCloseTo(0.6);
  });
});
