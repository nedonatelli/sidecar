import { describe, it, expect } from 'vitest';
import { extractFailures, formatFailuresMarkdown } from './ciFailure.js';

// ---------------------------------------------------------------------------
// Tests for ciFailure.ts (v0.68 chunk 4).
//
// Pure primitive — no network. Every case exercises a specific slice
// of GitHub Actions log syntax (timestamps, groups, error annotations,
// exit codes) and verifies the parser's tolerance for noise.
// ---------------------------------------------------------------------------

/**
 * Prefix each line with a synthetic GitHub Actions timestamp. The
 * parser strips these; tests use the helper to prove the stripping
 * works rather than hand-writing timestamps per case.
 */
function stamp(lines: readonly string[]): string {
  const base = Date.UTC(2026, 3, 18, 10, 0, 0);
  return lines
    .map((line, i) => {
      const ts = new Date(base + i * 1000).toISOString();
      return `${ts} ${line}`;
    })
    .join('\n');
}

describe('extractFailures', () => {
  it('returns empty array when the log has no ##[error] markers', () => {
    const log = stamp(['##[group]Run npm test', 'npm test output', 'all tests passed', '##[endgroup]']);
    expect(extractFailures(log)).toEqual([]);
  });

  it('extracts a single failure block with step name + error text', () => {
    const log = stamp([
      '##[group]Run npm test',
      'FAIL src/foo.test.ts',
      '  Expected: 1',
      '  Received: 2',
      '##[error]Process completed with exit code 1.',
      '##[endgroup]',
    ]);
    const blocks = extractFailures(log);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].stepName).toBe('Run npm test');
    expect(blocks[0].errorLines).toEqual(['Process completed with exit code 1.']);
    expect(blocks[0].exitCode).toBe(1);
    expect(blocks[0].contextBefore).toContain('FAIL src/foo.test.ts');
  });

  it('bounds context lines by the `contextLines` option', () => {
    const filler = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const log = stamp(['##[group]Run build', ...filler, '##[error]Build failed.', '##[endgroup]']);
    const blocks = extractFailures(log, { contextLines: 5 });
    expect(blocks[0].contextBefore).toHaveLength(5);
    expect(blocks[0].contextBefore[0]).toBe('line-45');
    expect(blocks[0].contextBefore[4]).toBe('line-49');
  });

  it('strips GitHub Actions timestamps before reasoning about the line', () => {
    const log = stamp([
      '##[group]compile',
      'tsc error TS2304',
      '##[error]Process completed with exit code 2.',
      '##[endgroup]',
    ]);
    const blocks = extractFailures(log);
    // The context lines should NOT contain the timestamp.
    expect(blocks[0].contextBefore[0]).toBe('tsc error TS2304');
    expect(blocks[0].errorLines[0]).toBe('Process completed with exit code 2.');
  });

  it('handles multiple distinct failing steps in one run', () => {
    const log = stamp([
      '##[group]lint',
      'lint error: no-unused-vars',
      '##[error]Process completed with exit code 1.',
      '##[endgroup]',
      '##[group]test',
      'FAIL suite',
      '##[error]Process completed with exit code 2.',
      '##[endgroup]',
    ]);
    const blocks = extractFailures(log);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].stepName).toBe('lint');
    expect(blocks[1].stepName).toBe('test');
    expect(blocks[0].exitCode).toBe(1);
    expect(blocks[1].exitCode).toBe(2);
  });

  it('captures top-level ##[error] lines with a placeholder step name', () => {
    const log = stamp(['##[group]build', 'ok', '##[endgroup]', '##[error]The job was cancelled.']);
    const blocks = extractFailures(log);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].stepName).toBe('(top-level)');
    expect(blocks[0].errorLines[0]).toBe('The job was cancelled.');
  });

  it('ignores groups without any ##[error] annotations entirely', () => {
    const log = stamp([
      '##[group]passing-step',
      'no errors here',
      '##[endgroup]',
      '##[group]failing-step',
      'something',
      '##[error]Exit 1.',
      '##[endgroup]',
    ]);
    const blocks = extractFailures(log);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].stepName).toBe('failing-step');
  });

  it('respects the `maxBlocks` cap when many errors fire', () => {
    const sections: string[] = [];
    for (let i = 0; i < 20; i++) {
      sections.push(`##[group]step-${i}`);
      sections.push(`something-${i}`);
      sections.push('##[error]Exit 1.');
      sections.push('##[endgroup]');
    }
    const log = stamp(sections);
    const blocks = extractFailures(log, { maxBlocks: 3 });
    expect(blocks).toHaveLength(3);
    expect(blocks[0].stepName).toBe('step-0');
    expect(blocks[2].stepName).toBe('step-2');
  });

  it('tolerates logs with no timestamps (raw local reproductions)', () => {
    const log = [
      '##[group]Run pytest',
      'E   AssertionError',
      '##[error]Process completed with exit code 1.',
      '##[endgroup]',
    ].join('\n');
    const blocks = extractFailures(log);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].errorLines[0]).toBe('Process completed with exit code 1.');
  });

  it('omits exitCode when no error line mentions one', () => {
    const log = stamp(['##[group]deploy', 'artifact upload failed', '##[error]Resource not found.', '##[endgroup]']);
    const blocks = extractFailures(log);
    expect(blocks[0].exitCode).toBeUndefined();
  });

  it('handles trailing lines without newline after the final error', () => {
    const log = ['##[group]final', 'last line', '##[error]Process completed with exit code 42.'].join('\n');
    const blocks = extractFailures(log);
    expect(blocks[0].exitCode).toBe(42);
  });
});

describe('formatFailuresMarkdown', () => {
  it('returns empty string when there are no blocks', () => {
    expect(formatFailuresMarkdown([])).toBe('');
  });

  it('renders each block with step name + exit code + error + context', () => {
    const md = formatFailuresMarkdown([
      {
        stepName: 'Run npm test',
        errorLines: ['Process completed with exit code 1.'],
        contextBefore: ['FAIL src/foo.test.ts', '  Expected: 1'],
        exitCode: 1,
      },
    ]);
    expect(md).toContain('### Step: Run npm test');
    expect(md).toContain('Exit code: 1');
    expect(md).toContain('FAIL src/foo.test.ts');
    expect(md).toContain('ERROR: Process completed with exit code 1.');
  });

  it('omits the exit-code line when the block has none', () => {
    const md = formatFailuresMarkdown([
      {
        stepName: 'deploy',
        errorLines: ['Not found.'],
        contextBefore: [],
        exitCode: undefined,
      },
    ]);
    expect(md).not.toContain('Exit code:');
  });
});
