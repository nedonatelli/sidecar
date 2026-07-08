import { describe, it, expect } from 'vitest';
import { normalizeOllamaHost } from './hostUrl.js';

describe('normalizeOllamaHost', () => {
  it('prefixes http:// on a schemeless host:port (the Vast template shape)', () => {
    expect(normalizeOllamaHost('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });

  it('leaves http/https URLs untouched', () => {
    expect(normalizeOllamaHost('http://localhost:11434')).toBe('http://localhost:11434');
    expect(normalizeOllamaHost('https://ollama.example.com')).toBe('https://ollama.example.com');
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(normalizeOllamaHost(' 10.0.0.5:11434 ')).toBe('http://10.0.0.5:11434');
  });

  it('handles bare hostnames', () => {
    expect(normalizeOllamaHost('gpu-box:11434')).toBe('http://gpu-box:11434');
  });

  it('returns empty string unchanged (caller falls back to its default)', () => {
    expect(normalizeOllamaHost('')).toBe('');
  });
});
