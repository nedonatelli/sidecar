import { describe, it, expect, vi } from 'vitest';
import { ruleRewrite, rewriteQuery } from './queryRewriter.js';
import type { CompleteFn } from './queryRewriter.js';

// ── ruleRewrite ───────────────────────────────────────────────────────────────

describe('ruleRewrite', () => {
  it('returns empty string for blank input', () => {
    expect(ruleRewrite('')).toBe('');
    expect(ruleRewrite('   ')).toBe('');
  });

  it('strips "can you help me with"', () => {
    expect(ruleRewrite('can you help me with authentication flow')).toBe('authentication flow');
  });

  it('strips "can you" without the long form', () => {
    expect(ruleRewrite('can you explain the retry logic')).toBe('explain the retry logic');
  });

  it('strips "how do I"', () => {
    expect(ruleRewrite('how do I configure the embed index')).toBe('configure the embed index');
  });

  it('strips "how to"', () => {
    expect(ruleRewrite('how to run tests')).toBe('run tests');
  });

  it('strips "what is"', () => {
    expect(ruleRewrite('what is the agent loop')).toBe('agent loop');
  });

  it('strips "what is a" (with article)', () => {
    expect(ruleRewrite('what is a retriever')).toBe('retriever');
  });

  it('strips "I want to"', () => {
    expect(ruleRewrite('I want to add a new tool')).toBe('add a new tool');
  });

  it('strips "I need to"', () => {
    expect(ruleRewrite('I need to fix the memory leak')).toBe('fix the memory leak');
  });

  it('strips "I\'m trying to"', () => {
    expect(ruleRewrite("I'm trying to debug the completion provider")).toBe('debug the completion provider');
  });

  it('strips "please help me"', () => {
    expect(ruleRewrite('please help me understand the embedding index')).toBe('understand the embedding index');
  });

  it('strips "please" alone', () => {
    expect(ruleRewrite('please show the file watcher logic')).toBe('show the file watcher logic');
  });

  it('strips chained preambles (e.g. "can you please help me")', () => {
    const result = ruleRewrite('can you please help me understand how to configure things');
    expect(result).not.toMatch(/^can\s+you/i);
    expect(result).not.toMatch(/^please/i);
    expect(result).not.toMatch(/^help\s+me/i);
  });

  it('expands camelCase identifiers', () => {
    expect(ruleRewrite('getEmbeddingIndex')).toBe('get Embedding Index');
  });

  it('expands inner camelCase in a sentence', () => {
    const result = ruleRewrite('how does streamChat work');
    expect(result).toContain('stream Chat');
  });

  it('leaves ALL_CAPS acronyms intact', () => {
    expect(ruleRewrite('HTTP request handling')).toBe('HTTP request handling');
    expect(ruleRewrite('URL parser implementation')).toBe('URL parser implementation');
  });

  it('leaves short words (< 3 chars) intact', () => {
    expect(ruleRewrite('fix IO error')).toBe('fix IO error');
  });

  it('leaves @file: and path references intact', () => {
    const q = 'show me @file:src/agent/loop.ts logic';
    const result = ruleRewrite(q);
    expect(result).toContain('@file:src/agent/loop.ts');
  });

  it('does not double-expand already-spaced words', () => {
    const result = ruleRewrite('stream chat connection');
    expect(result).toBe('stream chat connection');
  });

  it('handles already-clean queries without modification', () => {
    const q = 'embedding index cosine similarity search';
    expect(ruleRewrite(q)).toBe(q);
  });

  it('strips preamble and then expands camelCase', () => {
    const result = ruleRewrite('how do I use the FlatVectorStore');
    expect(result).toContain('Flat Vector Store');
    expect(result).not.toMatch(/^how\s+do\s+i/i);
  });
});

// ── rewriteQuery ──────────────────────────────────────────────────────────────

const noopComplete: CompleteFn = async () => '';

describe('rewriteQuery', () => {
  it("mode 'off' returns original query unchanged", async () => {
    const q = 'can you help me with the retry logic';
    const [result] = await rewriteQuery(q, 'off');
    expect(result).toBe(q);
  });

  it("mode 'rule' returns rule-cleaned query", async () => {
    const [result] = await rewriteQuery('how do I configure the streamChat', 'rule');
    expect(result).not.toMatch(/^how\s+do\s+i/i);
    expect(result).toContain('stream Chat');
  });

  it("mode 'rule' returns single-element array", async () => {
    const results = await rewriteQuery('agent loop', 'rule');
    expect(results).toHaveLength(1);
  });

  it("mode 'llm' without complete falls back to rule output", async () => {
    const [result] = await rewriteQuery('how do I fix the embedding index', 'llm');
    expect(result).not.toMatch(/^how\s+do\s+i/i); // rule applied
  });

  it("mode 'expand' without complete returns single rule-cleaned query", async () => {
    const results = await rewriteQuery('how do I use the vectorStore', 'expand');
    expect(results).toHaveLength(1);
    expect(results[0]).not.toMatch(/^how\s+do\s+i/i);
  });

  it("mode 'llm' uses LLM result when complete returns non-empty string", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('embedding index configuration');
    const [result] = await rewriteQuery('how does the embeddingIndex work', 'llm', complete);
    expect(result).toBe('embedding index configuration');
    expect(complete).toHaveBeenCalledOnce();
  });

  it("mode 'llm' takes only first line of LLM output", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('auth flow\nsecond line ignored');
    const [result] = await rewriteQuery('explain auth', 'llm', complete);
    expect(result).toBe('auth flow');
  });

  it("mode 'llm' strips trailing punctuation from LLM output", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('retry logic implementation.');
    const [result] = await rewriteQuery('retry', 'llm', complete);
    expect(result).toBe('retry logic implementation');
  });

  it("mode 'llm' falls back to rule output when LLM returns too-short string", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('ok'); // < 5 chars
    const [result] = await rewriteQuery('how does the streamChat work', 'llm', complete);
    // Falls back to rule output
    expect(result).toContain('stream Chat');
  });

  it("mode 'llm' falls back to rule output when complete throws", async () => {
    const complete: CompleteFn = vi.fn().mockRejectedValue(new Error('model busy'));
    const [result] = await rewriteQuery('how do I debug the agent loop', 'llm', complete);
    expect(result).not.toMatch(/^how\s+do\s+i/i);
    expect(result).toContain('debug');
  });

  it("mode 'expand' returns rule query + LLM variants", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('embedding search similarity\nvector store cosine');
    const results = await rewriteQuery('how does embedding search work', 'expand', complete);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).not.toMatch(/^how\s+does/i); // rule-cleaned
    expect(results).toContain('embedding search similarity');
    expect(results).toContain('vector store cosine');
  });

  it("mode 'expand' caps variants at 2", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('variant one\nvariant two\nvariant three ignored');
    const results = await rewriteQuery('test query', 'expand', complete);
    // rule-cleaned + 2 variants = 3 max
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("mode 'expand' strips bullets from LLM output lines", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('1. implementation details here\n- related API concepts');
    const results = await rewriteQuery('query', 'expand', complete);
    const variant = results.find((r) => r.includes('implementation details'));
    expect(variant).toBeDefined();
    expect(variant).not.toMatch(/^\d+\./);
  });

  it("mode 'expand' falls back to single query when LLM returns empty", async () => {
    const complete: CompleteFn = vi.fn().mockResolvedValue('');
    const results = await rewriteQuery('some query', 'expand', complete);
    expect(results).toHaveLength(1);
  });

  it('returns original for empty query regardless of mode', async () => {
    for (const mode of ['off', 'rule', 'llm', 'expand'] as const) {
      const results = await rewriteQuery('', mode, noopComplete);
      expect(results).toEqual(['']);
    }
  });

  it('timeout causes LLM fallback to rule output', async () => {
    const complete: CompleteFn = vi.fn().mockImplementation(
      (_sys, _msgs, _model, _max, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        }),
    );
    const [result] = await rewriteQuery(
      'how do I fix the embedding timeout',
      'llm',
      complete,
      undefined,
      50, // very short timeout
    );
    // Falls back to rule output since LLM timed out
    expect(result).not.toMatch(/^how\s+do\s+i/i);
    expect(result).toContain('fix');
  });
});
