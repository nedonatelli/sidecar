import { describe, it, expect } from 'vitest';
import {
  collapseWhitespace,
  truncateToolResult,
  truncateGrepResult,
  truncateForTool,
  truncateAllToolResults,
  dedupeToolResults,
  buildToolUseIdMap,
  formatPruneStats,
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

/** Two tool_result blocks that accidentally read the same file twice.
 *  `toolName` param (default `read_file`) lets tests vary which tool
 *  produced the output — critical for v0.62.1 p.2b which exempts
 *  some tools from dedup. */
function buildDuplicateReadsSession(content: string, toolName = 'read_file'): ChatMessage[] {
  return [
    { role: 'user', content: 'Look at helpers.ts and tell me what it does.' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: toolName,
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
          name: toolName,
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
    // Use a non-exempt tool so dedup actually fires (v0.62.1 p.2b
    // exempts read_file, git_diff, etc. from dedup — this test now
    // demonstrates the general mechanism via `grep`).
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'grep');
    const toolNames = buildToolUseIdMap(messages);
    const { messages: out, saved } = dedupeToolResults(messages, toolNames);

    expect(saved).toBeGreaterThan(0);

    // First tool_result keeps its full content.
    const first = (out[2].content as ToolResultContentBlock[])[0];
    expect(first.content).toBe(LARGE_FILE_CONTENT);

    // Second tool_result is replaced with the back-reference marker.
    const second = (out[5].content as ToolResultContentBlock[])[0];
    expect(second.content).toMatch(/identical to a previous tool_result/);
  });

  it('exempts read_file from dedup (v0.62.1 p.2b — back-reference-after-edit trap)', () => {
    // Canonical trap: agent reads foo.ts, edits foo.ts, reads foo.ts
    // again. Pre-p.2b dedup collapsed the second read into a pointer
    // at the stale FIRST read, silently hiding the agent's own edit.
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'read_file');
    const toolNames = buildToolUseIdMap(messages);
    const { messages: out, saved } = dedupeToolResults(messages, toolNames);

    expect(saved).toBe(0); // no dedup happened
    const second = (out[5].content as ToolResultContentBlock[])[0];
    expect(second.content).toBe(LARGE_FILE_CONTENT); // full content preserved
  });

  it('falls back to pre-p.2b behavior when no tool-name map is provided', () => {
    // Back-compat: callers that don't supply a map get the unguarded
    // legacy behavior (every tool is a dedup candidate).
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'read_file');
    const { saved } = dedupeToolResults(messages);
    expect(saved).toBeGreaterThan(0);
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
    expect(result.stats).toEqual({
      truncatedBytes: 0,
      dedupedBytes: 0,
      whitespaceBytes: 0,
      truncatedByTool: {},
    });
  });

  it('produces measurable savings on a verbose agent loop', () => {
    // Use `grep` so both truncation AND dedup fire (read_file is
    // dedup-exempt per v0.62.1 p.2b).
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'grep');

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

  it('records per-tool truncated bytes in stats.truncatedByTool (v0.62.1 p.2a)', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'grep');
    const result = prunePrompt('', messages, { enabled: true, maxToolResultTokens: 500 });
    expect(result.stats.truncatedByTool).toHaveProperty('grep');
    expect(result.stats.truncatedByTool.grep).toBeGreaterThan(0);
  });

  it('exempts read_file from dedup end-to-end (v0.62.1 p.2b)', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'read_file');
    const result = prunePrompt('', messages, { enabled: true, maxToolResultTokens: 500 });
    // Truncation still fires on both copies.
    expect(result.stats.truncatedBytes).toBeGreaterThan(0);
    // But dedup stays quiet — the "back-reference after edit" trap is closed.
    expect(result.stats.dedupedBytes).toBe(0);
  });
});

describe('buildToolUseIdMap', () => {
  it('resolves every tool_use block to its name', () => {
    const messages = buildDuplicateReadsSession(LARGE_FILE_CONTENT, 'grep');
    const map = buildToolUseIdMap(messages);
    expect(map.get('toolu_01')).toBe('grep');
    expect(map.get('toolu_02')).toBe('grep');
    expect(map.size).toBe(2);
  });

  it('returns an empty map when no tool_use blocks are present', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(buildToolUseIdMap(messages).size).toBe(0);
  });
});

describe('formatPruneStats', () => {
  it('returns empty string when nothing was pruned', () => {
    expect(formatPruneStats({ truncatedBytes: 0, dedupedBytes: 0, whitespaceBytes: 0, truncatedByTool: {} })).toBe('');
  });

  it('formats a one-line summary with per-tool breakdown', () => {
    const line = formatPruneStats({
      truncatedBytes: 4096,
      dedupedBytes: 2048,
      whitespaceBytes: 128,
      truncatedByTool: { grep: 3000, run_tests: 1096 },
    });
    expect(line).toContain('Pruner:');
    expect(line).toContain('truncated 4096B');
    expect(line).toContain('grep:3000B');
    expect(line).toContain('run_tests:1096B');
    expect(line).toContain('deduped 2048B');
    expect(line).toContain('whitespace 128B');
  });

  it('omits sections that are zero', () => {
    const line = formatPruneStats({
      truncatedBytes: 0,
      dedupedBytes: 500,
      whitespaceBytes: 0,
      truncatedByTool: {},
    });
    expect(line).toBe('Pruner: deduped 500B');
  });
});

// v0.63.0 — per-tool truncation dispatch. Grep output has
// matches distributed throughout, so head+tail (the default
// strategy) elides the middle matches — which are usually the
// most-interesting ones. The grep-aware strategy keeps whole
// lines from the head and drops the tail, preserving the natural
// file:line ordering of matches and producing a contiguous window.
describe('truncateGrepResult (v0.63.0)', () => {
  // Build a fake grep output of N matches, one per line.
  function fakeGrepOutput(matchCount: number): string {
    const lines: string[] = [];
    for (let i = 1; i <= matchCount; i++) {
      lines.push(`src/file${i}.ts:${i}:  const foo = bar.baz(${i});`);
    }
    return lines.join('\n');
  }

  it('is a no-op when the output fits under the budget', () => {
    const small = fakeGrepOutput(5);
    const result = truncateGrepResult(small, 4000);
    expect(result.saved).toBe(0);
    expect(result.text).toBe(small);
  });

  it('keeps whole lines from the head (no mid-line truncation) when over budget', () => {
    const big = fakeGrepOutput(5000);
    const result = truncateGrepResult(big, 100); // ~400 chars budget
    // Every kept line is a complete grep match line (no mid-line cuts).
    const lines = result.text.split('\n');
    // Last line is the elision marker — everything before must be a full match.
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]).toMatch(/^src\/file\d+\.ts:\d+:/);
    }
  });

  it('appends an elision marker telling the agent how many matches were dropped', () => {
    const big = fakeGrepOutput(1000);
    const result = truncateGrepResult(big, 200);
    expect(result.text).toContain('elided by SideCar prompt pruner');
    expect(result.text).toMatch(/kept first \d+ of 1000 matches/);
    // The marker also suggests narrowing the query — an actionable
    // hint the default head+tail marker cannot give.
    expect(result.text).toContain('Narrow the grep query');
  });

  it('respects file:line ordering — head matches survive, tail matches get elided', () => {
    const big = fakeGrepOutput(500);
    const result = truncateGrepResult(big, 100);
    // The first match must still be present.
    expect(result.text).toContain('src/file1.ts:1:');
    // The last match must be gone (elided).
    expect(result.text).not.toContain('src/file500.ts:500:');
  });

  it('handles a pathological single-line-overflow case by falling back to byte-slice', () => {
    const oneLine = 'src/file.ts:1:  ' + 'x'.repeat(50_000);
    const result = truncateGrepResult(oneLine, 100);
    // Budget is blown by one line; fall back to byte-truncate.
    expect(result.text.length).toBeLessThan(oneLine.length);
    expect(result.saved).toBeGreaterThan(0);
  });
});

describe('truncateForTool dispatch (v0.63.0)', () => {
  it('dispatches grep to truncateGrepResult', () => {
    const grepOut =
      ['src/foo.ts:1:match a', 'src/bar.ts:2:match b', 'src/baz.ts:3:match c'].join('\n') + '\n' + 'x'.repeat(10_000); // force over budget

    const result = truncateForTool('grep', grepOut, 100);
    // Grep strategy appends a kept-first-of marker; head+tail does not.
    expect(result.text).toContain('kept first');
  });

  it('falls through to truncateToolResult (head+tail) for any other tool name', () => {
    const readOut = 'function foo() {\n  return 42;\n}\n' + 'x'.repeat(10_000);
    const result = truncateForTool('read_file', readOut, 100);
    // Head+tail inserts an elision marker with bytes-elided count.
    expect(result.text).toContain('bytes elided');
    // And it does NOT append the grep-specific "kept first" marker.
    expect(result.text).not.toContain('kept first');
  });

  it('falls through to truncateToolResult when tool name is undefined (legacy callers)', () => {
    const text = 'x'.repeat(10_000);
    const result = truncateForTool(undefined, text, 100);
    expect(result.saved).toBeGreaterThan(0);
    // Default strategy, not grep-aware.
    expect(result.text).not.toContain('kept first');
  });

  it('truncateAllToolResults applies grep dispatch end-to-end', () => {
    const grepOut = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:${i}:match`).join('\n');
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_grep',
            name: 'grep',
            input: { pattern: 'match' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_grep',
            content: grepOut,
            is_error: false,
          } satisfies ToolResultContentBlock,
        ],
      },
    ];

    const toolNames = buildToolUseIdMap(messages);
    const { messages: out, saved, byTool } = truncateAllToolResults(messages, 100, toolNames);
    expect(saved).toBeGreaterThan(0);
    expect(byTool.grep).toBeGreaterThan(0);
    // The resulting tool_result carries the grep-aware marker, not the
    // generic bytes-elided one.
    const resultBlock = (out[1].content as Array<{ type: string; content?: string }>)[0];
    expect(resultBlock.content).toContain('kept first');
  });
});
