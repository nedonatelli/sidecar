import { describe, it, expect } from 'vitest';
import { parseHuggingFaceRef, isHuggingFaceRef, formatSize } from './huggingface.js';

describe('parseHuggingFaceRef', () => {
  it('parses full HTTPS URL', () => {
    const ref = parseHuggingFaceRef('https://huggingface.co/bartowski/Qwen3-Coder-GGUF');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('bartowski');
    expect(ref!.repo).toBe('Qwen3-Coder-GGUF');
    expect(ref!.ollamaName).toBe('hf.co/bartowski/Qwen3-Coder-GGUF');
  });

  it('parses URL without protocol', () => {
    const ref = parseHuggingFaceRef('huggingface.co/TheBloke/Llama-2-7B-GGUF');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('TheBloke');
    expect(ref!.repo).toBe('Llama-2-7B-GGUF');
  });

  it('parses hf.co shorthand', () => {
    const ref = parseHuggingFaceRef('hf.co/mistralai/Mistral-7B-v0.1');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('mistralai');
    expect(ref!.repo).toBe('Mistral-7B-v0.1');
    expect(ref!.ollamaName).toBe('hf.co/mistralai/Mistral-7B-v0.1');
  });

  it('handles trailing slash', () => {
    const ref = parseHuggingFaceRef('https://huggingface.co/org/repo/');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('org');
    expect(ref!.repo).toBe('repo');
  });

  it('returns null for non-HF URLs', () => {
    expect(parseHuggingFaceRef('https://github.com/org/repo')).toBeNull();
    expect(parseHuggingFaceRef('ollama/llama3')).toBeNull();
    expect(parseHuggingFaceRef('just a string')).toBeNull();
    expect(parseHuggingFaceRef('')).toBeNull();
  });

  it('handles whitespace', () => {
    const ref = parseHuggingFaceRef('  https://huggingface.co/org/repo  ');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('org');
  });
});

describe('isHuggingFaceRef', () => {
  it('returns true for HF URLs', () => {
    expect(isHuggingFaceRef('https://huggingface.co/org/repo')).toBe(true);
    expect(isHuggingFaceRef('hf.co/org/repo')).toBe(true);
  });

  it('returns false for non-HF strings', () => {
    expect(isHuggingFaceRef('llama3')).toBe(false);
    expect(isHuggingFaceRef('https://github.com/org/repo')).toBe(false);
  });
});

describe('formatSize', () => {
  it('formats bytes to GB', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('formats bytes to MB', () => {
    expect(formatSize(500 * 1024 * 1024)).toBe('500 MB');
    expect(formatSize(100 * 1024 * 1024)).toBe('100 MB');
  });

  it('returns unknown size for 0', () => {
    expect(formatSize(0)).toBe('unknown size');
  });
});
