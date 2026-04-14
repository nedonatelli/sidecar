import { describe, it, expect } from 'vitest';
import {
  collapseWhitespace,
  truncateToolResult,
  truncateAllToolResults,
  dedupeToolResults,
  prunePrompt,
} from './promptPruner.js';
import type { ChatMessage, ToolResultContentBlock } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures — realistic verbose prompts that SideCar would actually send.
// Kept as top-level constants so tests can show before/after savings.
// ---------------------------------------------------------------------------

/** A 5k-char "read_file" output — the kind of thing that blows up agent loops. */
const LARGE_FILE_CONTENT = [
  'File: src/utils/helpers.ts',
  '',
  ...Array.from({ length: 200 }, (_, i) => `export function helper${i}(x: number): number {`),
  ...Array.from({ length: 200 }, (_, i) => `  return x * ${i} + ${i * 2};`),
  ...Array.from({ length: 200 }, () => '}'),
  '',
  '// End of file',
].join('\n');

/** A system prompt with excessive blank lines from template concatenation. */
const NOISY_SYSTEM_PROMPT = `You are a helpful coding assistant.



## Rules



- Be concise
- Use tools when appropriate



## Workspace



Some workspace description here.




End of prompt.`;

/** Two tool_result blocks that accidentally read the same file twice. */
function buildDuplicateReadsSession(content: string): ChatMessage[] {
  return [
    { role: 'user', content: 'Look at helpers.ts and tell me what it does.' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'read_file',
          input: { path: 'src/utils/helpers.ts' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content } as ToolResultContentBlock],
    },
    { role: 'assistant', content: 'Let me re-read it to confirm.' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_02',
          name: 'read_file',
          input: { path: 'src/utils/helpers.ts' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content } as ToolResultContentBlock],
    },
  ];
}

// ---------------------------------------------------------------------------
// Unit tests per transform
// ---------------------------------------------------------------------------

describe('collapseWhitespace', () => {
  it('collapses 3+ blank lines to 2', () => {
    const { text, saved } = collapseWhitespace(NOISY_SYSTEM_PROMPT);
    expect(saved).toBeGreaterThan(0);
    expect(text).not.toMatch(/\n\s*\n\s*\n\s*\n/);
    // Normal 2-newline paragraph breaks are preserved.
    expect(text).toContain('\n\n');
  });

  it('is a no-op on clean prose', () => {
    const clean = 'One paragraph.\n\nAnother paragraph.\n';
    const { text, saved } = collapseWhitespace(clean);
    expect(saved).toBe(0);
    expect(text).toBe(clean);
  });
});

describe('truncateToolResult', () => {
  it('leaves short results alone', () => {
    const { text, saved } = truncateToolResult('small output', 2000);
    expect(saved).toBe(0);
    expect(text).toBe('small output');
  });

  it('head+tail truncates oversize results and inserts an elision marker', () => {
    const { text, saved } = truncateToolResult(LARGE_FILE_CONTENT, 500);
    expect(saved).toBeGreaterThan(0);
    expect(text).toContain('bytes elided by SideCar prompt pruner');
    // Head is preserved — first line of the file survives.
    expect(text.startsWith('File: src/utils/helpers.ts')).toBe(true);
    // Tail is preserved — last line of the file survives.
    expect(text).toContain('// End of file');
    // Result fits budget (with slop for the marker line).
    expect(text.length).toBeLessThanOrEqual(500 * 4 + 100);
  });

  it('handles pathologically small budgets gracefully', () => {
    const { text } = truncateToolResult(LARGE_FILE_CONTENT, 10);
    expect(text.length).toBeLessThanOrEqual(60);
  });
});

describe('dedupeToolResults', () => {
  it('replaces the second copy of a large tool_result with a back-reference', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT);
    const { messages: out, saved } = dedupeToolResults(messages);

    expect(saved).toBeGreaterThan(0);

    // First tool_result keeps its full content.
    const first = (out[2].content as ToolResultContentBlock[])[0];
    expect(first.content).toBe(LARGE_FILE_CONTENT);

    // Second tool_result is replaced with the back-reference marker.
    const second = (out[5].content as ToolResultContentBlock[])[0];
    expect(second.content).toMatch(/identical to a previous tool_result/);
  });

  it('does not dedupe small tool_results (under 200 chars)', () => {
    const small = 'ok';
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: small } as ToolResultContentBlock,
          { type: 'tool_result', tool_use_id: 'b', content: small } as ToolResultContentBlock,
        ],
      },
    ];
    const { saved } = dedupeToolResults(messages);
    expect(saved).toBe(0);
  });

  it('leaves string-content messages alone', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const { messages: out, saved } = dedupeToolResults(messages);
    expect(saved).toBe(0);
    expect(out).toEqual(messages);
  });
});

describe('truncateAllToolResults', () => {
  it('truncates every oversize tool_result in the message list', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT);
    const { messages: out, saved } = truncateAllToolResults(messages, 500);
    expect(saved).toBeGreaterThan(0);

    const first = (out[2].content as ToolResultContentBlock[])[0];
    const second = (out[5].content as ToolResultContentBlock[])[0];
    expect(first.content).toContain('bytes elided');
    expect(second.content).toContain('bytes elided');
  });
});

// ---------------------------------------------------------------------------
// Integration: the public prunePrompt() entry point used by backends
// ---------------------------------------------------------------------------

describe('prunePrompt', () => {
  it('is a no-op when disabled', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT);
    const result = prunePrompt(NOISY_SYSTEM_PROMPT, messages, {
      enabled: false,
      maxToolResultTokens: 500,
    });
    expect(result.systemPrompt).toBe(NOISY_SYSTEM_PROMPT);
    expect(result.messages).toBe(messages);
    expect(result.stats).toEqual({ truncatedBytes: 0, dedupedBytes: 0, whitespaceBytes: 0 });
  });

  it('produces measurable savings on a verbose agent loop', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT);

    const beforeSize = NOISY_SYSTEM_PROMPT.length + JSON.stringify(messages).length;
    const result = prunePrompt(NOISY_SYSTEM_PROMPT, messages, {
      enabled: true,
      maxToolResultTokens: 500,
    });
    const afterSize = result.systemPrompt.length + JSON.stringify(result.messages).length;

    // Verify the before/after gap is real.
    expect(afterSize).toBeLessThan(beforeSize);
    const reduction = 1 - afterSize / beforeSize;
    // We expect >50% reduction on this fixture — large duplicate reads + whitespace.
    expect(reduction).toBeGreaterThan(0.5);

    // Stats match the transformations.
    expect(result.stats.whitespaceBytes).toBeGreaterThan(0);
    expect(result.stats.truncatedBytes).toBeGreaterThan(0);
    expect(result.stats.dedupedBytes).toBeGreaterThan(0);

    // Log the numbers so `vitest --reporter=verbose` shows the comparison.
    console.log(
      `[prunePrompt fixture] before=${beforeSize}B  after=${afterSize}B  ` +
        `reduction=${(reduction * 100).toFixed(1)}%  ` +
        `whitespace=${result.stats.whitespaceBytes}B  ` +
        `truncated=${result.stats.truncatedBytes}B  ` +
        `deduped=${result.stats.dedupedBytes}B`,
    );
  });

  it('preserves user and assistant text messages verbatim', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please refactor helpers.ts to use arrow functions.' },
      { role: 'assistant', content: "I'll start by reading the file." },
    ];
    const result = prunePrompt('You are helpful.', messages, {
      enabled: true,
      maxToolResultTokens: 500,
    });
    expect(result.messages).toEqual(messages);
  });
});
