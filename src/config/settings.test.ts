import { describe, it, expect } from 'vitest';
import { isLocalOllama } from './settings.js';

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
