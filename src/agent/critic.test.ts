import { describe, it, expect } from 'vitest';
import {
  buildEditCriticPrompt,
  buildTestFailureCriticPrompt,
  parseCriticResponse,
  splitBySeverity,
  formatFindingsForChat,
  buildCriticInjection,
  CRITIC_SYSTEM_PROMPT,
  type CriticFinding,
  type CriticTrigger,
} from './critic.js';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe('CRITIC_SYSTEM_PROMPT', () => {
  it('is hostile, JSON-structured, and forbids improvements', () => {
    expect(CRITIC_SYSTEM_PROMPT).toContain('adversarial code reviewer');
    expect(CRITIC_SYSTEM_PROMPT).toContain('Do NOT suggest improvements');
    expect(CRITIC_SYSTEM_PROMPT).toContain('NO ISSUES');
    expect(CRITIC_SYSTEM_PROMPT).toContain('"findings"');
    expect(CRITIC_SYSTEM_PROMPT).toContain('"severity"');
  });
});

// ---------------------------------------------------------------------------
// buildEditCriticPrompt
// ---------------------------------------------------------------------------

describe('buildEditCriticPrompt', () => {
  const base = (): Extract<CriticTrigger, { kind: 'edit' }> => ({
    kind: 'edit',
    filePath: 'src/foo.ts',
    diff: '@@ -1,1 +1,1 @@\n-old\n+new',
  });

  it('includes the file path and wraps the diff in a diff fence', () => {
    const prompt = buildEditCriticPrompt(base());
    expect(prompt).toContain('File: src/foo.ts');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('-old');
    expect(prompt).toContain('+new');
  });

  it('asks the critic to attack the change', () => {
    const prompt = buildEditCriticPrompt(base());
    expect(prompt).toContain('Attack this change');
  });

  it('includes the stated intent when provided', () => {
    const prompt = buildEditCriticPrompt({ ...base(), intent: 'Fix the null-check bug' });
    expect(prompt).toContain('stated intent');
    expect(prompt).toContain('Fix the null-check bug');
  });

  it('omits the intent section when intent is empty or whitespace', () => {
    const prompt = buildEditCriticPrompt({ ...base(), intent: '   ' });
    expect(prompt).not.toContain('stated intent');
  });
});

// ---------------------------------------------------------------------------
// buildTestFailureCriticPrompt
// ---------------------------------------------------------------------------

describe('buildTestFailureCriticPrompt', () => {
  const base = (): Extract<CriticTrigger, { kind: 'test_failure' }> => ({
    kind: 'test_failure',
    testOutput: 'FAIL tests/foo.test.ts > adds two numbers\nExpected: 3\nReceived: 4',
    recentEdits: [{ filePath: 'src/foo.ts', diff: '@@ -1,1 +1,1 @@\n-a + b\n+a - b' }],
  });

  it('includes the test output and recent edit diffs', () => {
    const prompt = buildTestFailureCriticPrompt(base());
    expect(prompt).toContain('Test output');
    expect(prompt).toContain('FAIL tests/foo.test.ts');
    expect(prompt).toContain('Recent edits');
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('-a + b');
    expect(prompt).toContain('+a - b');
  });

  it('notes when no edits happened in the current turn', () => {
    const prompt = buildTestFailureCriticPrompt({ ...base(), recentEdits: [] });
    expect(prompt).toContain('No edits were made');
    expect(prompt).not.toContain('Recent edits');
  });

  it('asks the critic to root-cause the failure', () => {
    const prompt = buildTestFailureCriticPrompt(base());
    expect(prompt).toMatch(/Why did these tests fail/);
  });

  it('trims extremely long test output while preserving head and tail', () => {
    const hugeOutput = 'START ' + 'x'.repeat(10_000) + ' END';
    const prompt = buildTestFailureCriticPrompt({ ...base(), testOutput: hugeOutput });
    expect(prompt).toContain('START');
    expect(prompt).toContain('END');
    expect(prompt).toContain('truncated');
    expect(prompt.length).toBeLessThan(10_000); // bounded by MAX_CHARS
  });
});

// ---------------------------------------------------------------------------
// parseCriticResponse
// ---------------------------------------------------------------------------

describe('parseCriticResponse', () => {
  it('parses a well-shaped JSON object', () => {
    const raw = JSON.stringify({
      findings: [{ severity: 'high', title: 'Null deref', evidence: 'user.name at line 12 — user is nullable' }],
    });
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].title).toBe('Null deref');
    expect(result.explicitlyClean).toBe(false);
    expect(result.malformed).toBe(false);
  });

  it('handles multiple findings with mixed severity', () => {
    const raw = JSON.stringify({
      findings: [
        { severity: 'high', title: 'Race condition', evidence: 'lock released before write' },
        { severity: 'low', title: 'Missing error message', evidence: 'throw without context' },
      ],
    });
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.severity)).toEqual(['high', 'low']);
  });

  it('returns explicitlyClean for an empty findings array', () => {
    const result = parseCriticResponse('{"findings": []}');
    expect(result.findings).toEqual([]);
    expect(result.explicitlyClean).toBe(true);
    expect(result.malformed).toBe(false);
  });

  it('recognizes "NO ISSUES" as an explicit clean sentinel', () => {
    const result = parseCriticResponse('NO ISSUES');
    expect(result.explicitlyClean).toBe(true);
    expect(result.malformed).toBe(false);
  });

  it('recognizes "NO ISSUES" with trailing whitespace / punctuation', () => {
    const result = parseCriticResponse('  NO ISSUES.  \n');
    expect(result.explicitlyClean).toBe(true);
  });

  it('strips markdown fences around JSON', () => {
    const raw = '```json\n{"findings": [{"severity": "low", "title": "x", "evidence": "y"}]}\n```';
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
  });

  it('strips plain ``` fences around JSON', () => {
    const raw = '```\n{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}\n```';
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
  });

  it('tolerates leading prose before the JSON', () => {
    const raw = 'Here is my review:\n\n{"findings": [{"severity": "low", "title": "x", "evidence": "y"}]}';
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
  });

  it('accepts a naked findings array without the top-level wrapper', () => {
    const raw = '[{"severity": "high", "title": "x", "evidence": "y"}]';
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
  });

  it('drops entries with invalid severity but keeps the rest', () => {
    const raw = JSON.stringify({
      findings: [
        { severity: 'critical', title: 'x', evidence: 'y' }, // invalid severity
        { severity: 'high', title: 'real', evidence: 'real evidence' },
      ],
    });
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('real');
  });

  it('drops entries with empty title or evidence', () => {
    const raw = JSON.stringify({
      findings: [
        { severity: 'high', title: '', evidence: 'y' },
        { severity: 'high', title: 'x', evidence: '' },
        { severity: 'low', title: 'x', evidence: 'y' },
      ],
    });
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
  });

  it('flags completely unparseable responses as malformed', () => {
    const result = parseCriticResponse('this is not json at all');
    expect(result.malformed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.explicitlyClean).toBe(false);
  });

  it('flags responses with unbalanced braces as malformed', () => {
    const result = parseCriticResponse('{"findings": [{"severity": "high"');
    expect(result.malformed).toBe(true);
  });

  it('flags responses with the wrong top-level shape as malformed', () => {
    const result = parseCriticResponse('{"other_key": "whatever"}');
    expect(result.malformed).toBe(true);
  });

  it('handles embedded JSON strings with special characters', () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: 'high',
          title: 'Unclosed brace',
          evidence: 'Line 42 has a `{` with no matching `}` — the function body is malformed',
        },
      ],
    });
    const result = parseCriticResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toContain('matching');
  });
});

// ---------------------------------------------------------------------------
// splitBySeverity
// ---------------------------------------------------------------------------

describe('splitBySeverity', () => {
  const findings: CriticFinding[] = [
    { severity: 'high', title: 'h1', evidence: 'e1' },
    { severity: 'low', title: 'l1', evidence: 'e2' },
    { severity: 'high', title: 'h2', evidence: 'e3' },
  ];

  it('separates high-severity findings', () => {
    const { high, low } = splitBySeverity(findings);
    expect(high).toHaveLength(2);
    expect(low).toHaveLength(1);
    expect(high.map((f) => f.title)).toEqual(['h1', 'h2']);
  });

  it('returns empty arrays when given no findings', () => {
    const { high, low } = splitBySeverity([]);
    expect(high).toEqual([]);
    expect(low).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatFindingsForChat
// ---------------------------------------------------------------------------

describe('formatFindingsForChat', () => {
  const trigger: CriticTrigger = { kind: 'edit', filePath: 'src/foo.ts', diff: '' };

  it('renders an empty string when no findings', () => {
    expect(formatFindingsForChat([], trigger)).toBe('');
  });

  it('includes a header and one block per finding', () => {
    const result = formatFindingsForChat(
      [
        { severity: 'high', title: 'Bad', evidence: 'very bad' },
        { severity: 'low', title: 'Mild', evidence: 'slightly bad' },
      ],
      trigger,
    );
    expect(result).toContain('Critic review');
    expect(result).toContain('**Bad**');
    expect(result).toContain('very bad');
    expect(result).toContain('**Mild**');
    expect(result).toContain('slightly bad');
  });

  it('uses a different header for test-failure triggers', () => {
    const testTrigger: CriticTrigger = { kind: 'test_failure', testOutput: '', recentEdits: [] };
    const result = formatFindingsForChat([{ severity: 'high', title: 'x', evidence: 'y' }], testTrigger);
    expect(result).toContain('test failure');
  });

  it('escapes markdown emphasis chars in titles', () => {
    const result = formatFindingsForChat([{ severity: 'low', title: 'bold*problem_here', evidence: 'z' }], trigger);
    expect(result).toContain('bold\\*problem\\_here');
  });
});

// ---------------------------------------------------------------------------
// buildCriticInjection
// ---------------------------------------------------------------------------

describe('buildCriticInjection', () => {
  const findings: CriticFinding[] = [
    { severity: 'high', title: 'Race condition', evidence: 'lock released early' },
    { severity: 'high', title: 'Null deref', evidence: 'user.name when user is nullable' },
  ];

  it('labels the injection with attempt/max counter', () => {
    const injection = buildCriticInjection(findings, 1, 2);
    expect(injection).toContain('Critic review — attempt 1 of 2');
  });

  it('includes every finding title and evidence', () => {
    const injection = buildCriticInjection(findings, 1, 2);
    expect(injection).toContain('Race condition');
    expect(injection).toContain('lock released early');
    expect(injection).toContain('Null deref');
    expect(injection).toContain('user.name when user is nullable');
  });

  it('instructs the agent not to write a summary before resolving issues', () => {
    const injection = buildCriticInjection(findings, 1, 2);
    expect(injection).toContain('"Summary of Changes"');
  });

  it('adds a final-attempt warning only when attempt equals max', () => {
    expect(buildCriticInjection(findings, 1, 2)).not.toContain('final critic-review attempt');
    expect(buildCriticInjection(findings, 2, 2)).toContain('final critic-review attempt');
  });

  it('tells the agent it can challenge the reviewer if wrong', () => {
    const injection = buildCriticInjection(findings, 1, 2);
    expect(injection).toContain('explain why the reviewer is wrong');
  });
});
