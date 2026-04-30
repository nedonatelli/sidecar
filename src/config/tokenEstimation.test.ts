import { describe, it, expect } from 'vitest';
import { estimateTokensFromText, estimateTokensFromState } from './tokenEstimation.js';

describe('estimateTokensFromText', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokensFromText('')).toBe(0);
  });

  it('uses ~4 chars/token for English prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const tokens = estimateTokensFromText(text);
    const flat = Math.ceil(text.length / 4);
    expect(tokens).toBe(flat);
  });

  it('uses ~2.5 chars/token for code-dense content', () => {
    // High density of {, }, (, ), ;, =
    const code = 'function foo(x) { return x === 1 ? (x + 2) : (x - 3); }'.repeat(30);
    const tokens = estimateTokensFromText(code);
    const codeFlatEstimate = Math.ceil(code.length / 2.5);
    // Should be within 20% of code ratio
    expect(tokens).toBeGreaterThan(codeFlatEstimate * 0.8);
    expect(tokens).toBeLessThan(codeFlatEstimate * 1.2);
  });

  it('uses ~1.5 chars/token for CJK-dominant text', () => {
    // >30% CJK codepoints
    const cjk = '日本語のテキスト '.repeat(40);
    const tokens = estimateTokensFromText(cjk);
    const cjkFlatEstimate = Math.ceil(cjk.length / 1.5);
    expect(tokens).toBeGreaterThan(cjkFlatEstimate * 0.8);
    expect(tokens).toBeLessThan(cjkFlatEstimate * 1.2);
  });
});

describe('estimateTokensFromState', () => {
  it('returns 0 when totalChars is 0', () => {
    expect(estimateTokensFromState(0, [])).toBe(0);
  });

  it('falls back to English ratio with no messages', () => {
    const chars = 4000;
    expect(estimateTokensFromState(chars, [])).toBe(Math.ceil(chars / 4));
  });

  it('samples message content to pick ratio', () => {
    const cjkMessages = [
      { role: 'user' as const, content: '日本語テキスト'.repeat(50) },
      { role: 'assistant' as const, content: '返事です。'.repeat(50) },
    ];
    const chars = 2000;
    const tokensFromCjk = estimateTokensFromState(chars, cjkMessages);
    const tokensFromEnglish = estimateTokensFromState(chars, []);
    // CJK estimate should require fewer tokens (shorter chars/token ratio)
    expect(tokensFromCjk).toBeGreaterThan(tokensFromEnglish);
  });
});
