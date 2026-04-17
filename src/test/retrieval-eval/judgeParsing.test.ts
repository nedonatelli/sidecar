import { describe, it, expect } from 'vitest';
import {
  buildRelevanceSystemPrompt,
  buildRelevanceUserMessage,
  buildAnswerSystemPrompt,
  buildAnswerUserMessage,
  parseRelevanceVerdict,
  parseAnswerVerdict,
  JUDGE_BODY_CHAR_CAP,
  ANSWER_JUDGE_HIT_CAP,
} from './judgeParsing.js';

/**
 * Deterministic tests for the LLM-judge's pure prompt-building +
 * verdict-parsing primitives (v0.62 e.3). The judge itself lives
 * under `tests/llm-eval/retrievalJudge.ts` and runs only with a
 * real API key, but these functions are the load-bearing pieces —
 * a prompt-engineering bug or a parser edge case will surface
 * here before anyone spends tokens.
 */

describe('parseRelevanceVerdict', () => {
  it('maps RELEVANT → 1.0', () => {
    expect(parseRelevanceVerdict('RELEVANT')).toBe(1);
  });
  it('maps BORDERLINE → 0.5', () => {
    expect(parseRelevanceVerdict('BORDERLINE')).toBe(0.5);
  });
  it('maps IRRELEVANT → 0.0', () => {
    expect(parseRelevanceVerdict('IRRELEVANT')).toBe(0);
  });
  it('is case-insensitive', () => {
    expect(parseRelevanceVerdict('relevant')).toBe(1);
    expect(parseRelevanceVerdict('Borderline')).toBe(0.5);
  });
  it('tolerates surrounding whitespace', () => {
    expect(parseRelevanceVerdict('  RELEVANT\n')).toBe(1);
  });
  it('returns 0 on unparseable input (empty, chatty, garbled)', () => {
    expect(parseRelevanceVerdict('')).toBe(0);
    expect(parseRelevanceVerdict('I think this is related...')).toBe(0);
    expect(parseRelevanceVerdict('yes')).toBe(0);
  });
});

describe('parseAnswerVerdict', () => {
  it('maps ANSWERED / PARTIAL / MISSED', () => {
    expect(parseAnswerVerdict('ANSWERED')).toBe(1);
    expect(parseAnswerVerdict('PARTIAL')).toBe(0.5);
    expect(parseAnswerVerdict('MISSED')).toBe(0);
  });
  it('returns 0 on unparseable input', () => {
    expect(parseAnswerVerdict('kinda')).toBe(0);
    expect(parseAnswerVerdict('')).toBe(0);
  });
});

describe('buildRelevanceSystemPrompt', () => {
  it('includes the three-level rubric + one-word answer instruction', () => {
    const prompt = buildRelevanceSystemPrompt();
    expect(prompt).toContain('RELEVANT');
    expect(prompt).toContain('BORDERLINE');
    expect(prompt).toContain('IRRELEVANT');
    expect(prompt).toContain('one word');
  });
});

describe('buildRelevanceUserMessage', () => {
  it('includes the query, qualified name, and body inside a code fence', () => {
    const msg = buildRelevanceUserMessage({
      query: 'how does auth work',
      qualifiedName: 'requireAuth',
      kind: 'function',
      body: 'function requireAuth() {}',
    });
    expect(msg).toContain('Query: how does auth work');
    expect(msg).toContain('Symbol: requireAuth (function)');
    expect(msg).toContain('```');
    expect(msg).toContain('function requireAuth()');
  });

  it('truncates the body to JUDGE_BODY_CHAR_CAP', () => {
    const hugeBody = 'x'.repeat(5_000);
    const msg = buildRelevanceUserMessage({ query: 'q', qualifiedName: 'sym', kind: 'fn', body: hugeBody });
    // The message wraps body with a modest header + code fence. The
    // cap applies to the body text specifically, not the whole
    // message, so the total can exceed `JUDGE_BODY_CHAR_CAP` but
    // the body segment between ``` fences must be ≤ cap.
    const fenceStart = msg.indexOf('```') + 3;
    const fenceEnd = msg.lastIndexOf('```');
    const bodyInMessage = msg.slice(fenceStart, fenceEnd);
    expect(bodyInMessage.replace(/^\n|\n$/g, '').length).toBeLessThanOrEqual(JUDGE_BODY_CHAR_CAP);
  });
});

describe('buildAnswerSystemPrompt', () => {
  it('lists ANSWERED / PARTIAL / MISSED as the only valid verdicts', () => {
    const prompt = buildAnswerSystemPrompt();
    expect(prompt).toContain('ANSWERED');
    expect(prompt).toContain('PARTIAL');
    expect(prompt).toContain('MISSED');
  });
});

describe('buildAnswerUserMessage', () => {
  it('numbers each hit starting at #1 with qualified name + kind', () => {
    const msg = buildAnswerUserMessage({
      query: 'q',
      hits: [
        { query: 'q', qualifiedName: 'one', kind: 'function', body: 'a' },
        { query: 'q', qualifiedName: 'two', kind: 'class', body: 'b' },
      ],
    });
    expect(msg).toContain('#1 one (function)');
    expect(msg).toContain('#2 two (class)');
  });

  it('caps the listed hits at ANSWER_JUDGE_HIT_CAP regardless of input size', () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      query: 'q',
      qualifiedName: `sym${i}`,
      kind: 'fn',
      body: 'b',
    }));
    const msg = buildAnswerUserMessage({ query: 'q', hits });
    expect(msg).toContain(`#${ANSWER_JUDGE_HIT_CAP} sym${ANSWER_JUDGE_HIT_CAP - 1}`);
    expect(msg).not.toContain(`#${ANSWER_JUDGE_HIT_CAP + 1}`);
  });
});
