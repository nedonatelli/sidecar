import { describe, it, expect } from 'vitest';
import { parseModelSentinel } from './modelSentinels.js';

describe('parseModelSentinel', () => {
  it('returns the original text unchanged when no sentinel is present', () => {
    const r = parseModelSentinel('hello world');
    expect(r.cleaned).toBe('hello world');
    expect(r.override).toBeNull();
  });

  it('strips @opus and returns the Opus model id', () => {
    const r = parseModelSentinel('@opus think harder about this problem');
    expect(r.cleaned).toBe('think harder about this problem');
    expect(r.override).toBe('claude-opus-4-6');
  });

  it('strips @sonnet', () => {
    const r = parseModelSentinel('@sonnet review this diff');
    expect(r.cleaned).toBe('review this diff');
    expect(r.override).toBe('claude-sonnet-4-6');
  });

  it('strips @haiku', () => {
    const r = parseModelSentinel('@haiku just summarize');
    expect(r.cleaned).toBe('just summarize');
    expect(r.override).toBe('claude-haiku-4-5');
  });

  it('strips @local and resolves to the shipped Ollama default', () => {
    const r = parseModelSentinel('@local run offline');
    expect(r.cleaned).toBe('run offline');
    expect(r.override).toMatch(/^qwen3-coder|^qwen2\.5-coder|ollama/); // whatever OLLAMA_DEFAULT_MODEL is today
  });

  it('matches case-insensitively', () => {
    const r = parseModelSentinel('@Opus DO A THING');
    expect(r.override).toBe('claude-opus-4-6');
  });

  it('respects word boundary — @opusify is not @opus', () => {
    const r = parseModelSentinel('@opusify the text');
    expect(r.cleaned).toBe('@opusify the text');
    expect(r.override).toBeNull();
  });

  it('only matches at the start of the trimmed text', () => {
    const r = parseModelSentinel('check the @opus tag here');
    expect(r.cleaned).toBe('check the @opus tag here');
    expect(r.override).toBeNull();
  });

  it('handles a sentinel with no trailing content', () => {
    const r = parseModelSentinel('@haiku');
    expect(r.cleaned).toBe('');
    expect(r.override).toBe('claude-haiku-4-5');
  });

  it('allows leading whitespace before the sentinel', () => {
    const r = parseModelSentinel('  @sonnet analyze this');
    expect(r.cleaned).toBe('analyze this');
    expect(r.override).toBe('claude-sonnet-4-6');
  });

  it('only consumes one sentinel — chained sentinels keep the second as prose', () => {
    const r = parseModelSentinel('@opus @haiku why');
    expect(r.cleaned).toBe('@haiku why');
    expect(r.override).toBe('claude-opus-4-6');
  });
});
