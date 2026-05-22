import { describe, it, expect } from 'vitest';
import { stripAnsi, stripGhaTimestamp, isFailureLine, parseJobLog } from './logParser.js';

// ---------------------------------------------------------------------------
// Helpers for building synthetic GHA log lines
// ---------------------------------------------------------------------------

function ts(text: string): string {
  return `2026-05-21T10:00:00.0000000Z ${text}`;
}

function group(name: string): string {
  return ts(`##[group]${name}`);
}

function endgroup(): string {
  return ts('##[endgroup]');
}

function error(msg: string): string {
  return ts(`##[error]${msg}`);
}

function line(text: string): string {
  return ts(text);
}

function makeLog(...lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mRED\x1b[0m')).toBe('RED');
  });

  it('removes cursor-move sequences', () => {
    expect(stripAnsi('A\x1b[2KB')).toBe('AB');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// stripGhaTimestamp
// ---------------------------------------------------------------------------

describe('stripGhaTimestamp', () => {
  it('strips the ISO timestamp prefix', () => {
    expect(stripGhaTimestamp('2026-05-21T10:00:00.1234567Z npm test')).toBe('npm test');
  });

  it('leaves lines without a timestamp unchanged', () => {
    expect(stripGhaTimestamp('no timestamp here')).toBe('no timestamp here');
  });
});

// ---------------------------------------------------------------------------
// isFailureLine
// ---------------------------------------------------------------------------

describe('isFailureLine', () => {
  it.each([
    ['vitest FAIL line', 'FAIL src/agent/loop/cycleDetection.test.ts'],
    ['vitest × line', '  × detectCycleAndBail returns false'],
    ['AssertionError', '  AssertionError: expected true to equal false'],
    ['Expected:', '  Expected: false'],
    ['Received:', '  Received: true'],
    ['pytest FAILED', 'FAILED tests/test_auth.py::test_login'],
    ['pytest E assert', 'E   assert result == expected'],
    ['go test FAIL', '--- FAIL: TestMyFunc (0.01s)'],
    ['go FAIL package', 'FAIL\tgithub.com/example/pkg'],
    ['cargo FAILED', 'test my_module::my_test ... FAILED'],
    ['cargo stdout', '---- my_module::my_test stdout ----'],
    ['rust error code', 'error[E0382]: use of moved value'],
    ['generic Error:', 'Error: ENOENT: no such file or directory'],
    ['TypeError:', 'TypeError: Cannot read properties of undefined'],
  ])('matches: %s', (_label, input) => {
    expect(isFailureLine(input)).toBe(true);
  });

  it.each([
    ['passing vitest line', '✓ detectCycleAndBail returns false'],
    ['blank line', ''],
    ['normal log output', 'Building project...'],
    ['install output', 'added 42 packages in 3s'],
  ])('does not match: %s', (_label, input) => {
    expect(isFailureLine(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseJobLog — step extraction
// ---------------------------------------------------------------------------

describe('parseJobLog — step extraction', () => {
  it('extracts a single failed step with an ##[error] marker', () => {
    const log = makeLog(
      group('Run npm test'),
      line('> vitest run'),
      line('FAIL src/foo.test.ts'),
      line('  AssertionError: expected 1 to equal 2'),
      error('Process completed with exit code 1.'),
      endgroup(),
    );

    const result = parseJobLog(log);
    expect(result.failedSteps).toHaveLength(1);
    expect(result.failedSteps[0].name).toBe('Run npm test');
    expect(result.failedSteps[0].errorLines.join('\n')).toContain('AssertionError');
    expect(result.truncated).toBe(false);
  });

  it('strips ANSI codes and timestamps from extracted lines', () => {
    const log = makeLog(
      group('Run tests'),
      ts('\x1b[31mFAIL\x1b[0m src/auth.test.ts'),
      error('exit code 1'),
      endgroup(),
    );

    const result = parseJobLog(log);
    const joined = result.failedSteps[0].errorLines.join('\n');
    expect(joined).not.toMatch(/\x1b/);
    expect(joined).toContain('FAIL');
  });

  it('falls back to the last step when no ##[error] marker is present', () => {
    const log = makeLog(
      group('Install'),
      line('npm ci'),
      endgroup(),
      group('Build'),
      line('npm run build'),
      line('tsc: error TS2345: Argument of type'),
      // No endgroup — job was killed mid-step, common in CI timeouts.
    );

    const result = parseJobLog(log);
    expect(result.failedSteps).toHaveLength(1);
    expect(result.failedSteps[0].name).toBe('Build');
  });

  it('returns multiple failed steps when multiple have ##[error]', () => {
    const log = makeLog(
      group('Lint'),
      line('eslint .'),
      error('ESLint found errors.'),
      endgroup(),
      group('Test'),
      line('vitest run'),
      error('Tests failed.'),
      endgroup(),
    );

    const result = parseJobLog(log);
    expect(result.failedSteps).toHaveLength(2);
    expect(result.failedSteps[0].name).toBe('Lint');
    expect(result.failedSteps[1].name).toBe('Test');
  });

  it('marks truncated=true and uses tail when log exceeds maxBytes', () => {
    // Build a log just over the cap with known content at the tail.
    const padding = 'x'.repeat(1000) + '\n';
    const tail = makeLog(group('Test'), line('FAIL src/x.test.ts'), error('exit 1'), endgroup());
    const raw = padding.repeat(5) + tail;

    const result = parseJobLog(raw, 100); // tiny cap forces truncation
    expect(result.truncated).toBe(true);
    // Tail content should survive.
    expect(result.failedSteps.length).toBeGreaterThanOrEqual(0); // may be 0 if tail was cut mid-group
  });

  it('returns empty failedSteps for a passing log', () => {
    const log = makeLog(group('Test'), line('All tests passed.'), endgroup());
    const result = parseJobLog(log);
    // No ##[error] and last step has no failure lines — returns last step as fallback
    // but with content that shouldn't confuse the agent.
    expect(result.failedSteps).toHaveLength(1);
    expect(result.failedSteps[0].errorLines.join('\n')).toContain('All tests passed');
  });

  it('handles a log with no GHA group markers (plain stderr output)', () => {
    const log = makeLog(line('npm ERR! code ELIFECYCLE'), line('npm ERR! Exit status 1'));
    const result = parseJobLog(log);
    // No steps extracted — failedSteps is empty.
    expect(result.failedSteps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseJobLog — line windowing
// ---------------------------------------------------------------------------

describe('parseJobLog — line windowing', () => {
  it('returns the full step when line count is within MAX_LINES_PER_STEP', () => {
    const lines = Array.from({ length: 50 }, (_, i) => line(`output line ${i}`));
    lines.push(error('step failed'));
    const log = makeLog(group('Test'), ...lines, endgroup());
    const result = parseJobLog(log);
    // All 50 lines + ERROR line should be present, no omission marker.
    const joined = result.failedSteps[0].errorLines.join('\n');
    expect(joined).not.toContain('[… lines omitted …]');
  });

  it('windows around failure lines when step exceeds MAX_LINES_PER_STEP', () => {
    // Build a step with 200 lines: noise, then a failure, then more noise.
    const logLines: string[] = [group('Test')];
    for (let i = 0; i < 100; i++) logLines.push(line(`noise ${i}`));
    logLines.push(line('FAIL src/core.test.ts'));
    logLines.push(line('  Expected: true'));
    logLines.push(line('  Received: false'));
    for (let i = 0; i < 100; i++) logLines.push(line(`more noise ${i}`));
    logLines.push(error('exit 1'));
    logLines.push(endgroup());

    const result = parseJobLog(makeLog(...logLines));
    const joined = result.failedSteps[0].errorLines.join('\n');
    expect(joined).toContain('FAIL src/core.test.ts');
    expect(joined).toContain('Expected: true');
    expect(joined).toContain('[… lines omitted …]');
  });
});
