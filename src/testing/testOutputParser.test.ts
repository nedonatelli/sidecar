import { describe, it, expect } from 'vitest';
import { parseTestOutput } from './testOutputParser.js';

const VITEST_OUTPUT = `
 RUN  v1.0.0

 ✓ src/foo.test.ts > describe block > adds numbers 5ms
 × src/bar.test.ts > failing test 2ms
 ↓ src/baz.test.ts > skipped test

Test Files  1 failed | 2 passed (3)
Tests  1 failed | 1 skipped | 1 passed (3)
`;

const PYTEST_OUTPUT = `
PASSED tests/test_foo.py::test_add
FAILED tests/test_foo.py::test_subtract
PASSED tests/test_bar.py::test_multiply

3 passed, 1 failed in 0.5s
`;

const GO_OUTPUT = `
--- PASS: TestAdd (0.00s)
--- FAIL: TestSubtract (0.01s)
--- PASS: TestMultiply (0.00s)
ok  	example/math	0.015s
`;

const RUST_OUTPUT = `
running 3 tests
test math::add ... ok
test math::subtract ... FAILED
test math::multiply ... ignored

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out
`;

describe('parseTestOutput', () => {
  it('returns total=0 for empty output', () => {
    const result = parseTestOutput('');
    expect(result.total).toBe(0);
    expect(result.ecosystem).toBe('unknown');
  });

  describe('vitest', () => {
    it('detects vitest ecosystem', () => {
      const result = parseTestOutput(VITEST_OUTPUT);
      expect(result.ecosystem).toBe('vitest');
    });

    it('parses a pass', () => {
      const result = parseTestOutput(VITEST_OUTPUT);
      const pass = result.tests.find((t) => t.status === 'pass');
      expect(pass).toBeDefined();
      expect(pass!.name).toContain('adds numbers');
    });

    it('parses a fail', () => {
      const result = parseTestOutput(VITEST_OUTPUT);
      const fail = result.tests.find((t) => t.status === 'fail');
      expect(fail).toBeDefined();
    });

    it('parses a skip', () => {
      const result = parseTestOutput(VITEST_OUTPUT);
      const skip = result.tests.find((t) => t.status === 'skip');
      expect(skip).toBeDefined();
    });

    it('counts correctly', () => {
      const result = parseTestOutput(VITEST_OUTPUT);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(3);
    });
  });

  describe('pytest', () => {
    it('detects pytest ecosystem', () => {
      const result = parseTestOutput(PYTEST_OUTPUT);
      expect(result.ecosystem).toBe('pytest');
    });

    it('parses pass and fail lines', () => {
      const result = parseTestOutput(PYTEST_OUTPUT);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('extracts file paths', () => {
      const result = parseTestOutput(PYTEST_OUTPUT);
      const passTest = result.tests.find((t) => t.status === 'pass');
      expect(passTest?.filePath).toBe('tests/test_foo.py');
    });
  });

  describe('go', () => {
    it('detects go ecosystem', () => {
      const result = parseTestOutput(GO_OUTPUT);
      expect(result.ecosystem).toBe('go');
    });

    it('parses PASS/FAIL lines', () => {
      const result = parseTestOutput(GO_OUTPUT);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('extracts test names and durations', () => {
      const result = parseTestOutput(GO_OUTPUT);
      const passTest = result.tests.find((t) => t.name === 'TestAdd');
      expect(passTest?.status).toBe('pass');
      expect(passTest?.duration).toBe(0);
    });
  });

  describe('rust', () => {
    it('detects rust ecosystem', () => {
      const result = parseTestOutput(RUST_OUTPUT);
      expect(result.ecosystem).toBe('rust');
    });

    it('parses ok/FAILED/ignored lines', () => {
      const result = parseTestOutput(RUST_OUTPUT);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('extracts test names', () => {
      const result = parseTestOutput(RUST_OUTPUT);
      const okTest = result.tests.find((t) => t.name === 'math::add');
      expect(okTest?.status).toBe('pass');
    });
  });

  describe('jest', () => {
    const JEST_SUMMARY = 'Tests:       1 passed, 1 failed, 2 total\n';
    const JEST_PASS_FILE = 'PASS src/foo.test.ts\n';
    const JEST_FAIL_FILE = 'FAIL src/bar.test.ts\n';

    it('detects jest via PASS + Tests: summary', () => {
      const output = JEST_PASS_FILE + JEST_SUMMARY + '  ✓ a passing test (3ms)\n';
      expect(parseTestOutput(output).ecosystem).toBe('jest');
    });

    it('detects jest via FAIL + Test Suites: summary', () => {
      const output = JEST_FAIL_FILE + 'Test Suites: 1 failed, 1 total\n  ✕ broken test\n';
      expect(parseTestOutput(output).ecosystem).toBe('jest');
    });

    it('parses passing and failing tests', () => {
      const output = JEST_PASS_FILE + JEST_SUMMARY + '  ✓ works (2ms)\n  ✕ throws (1ms)\n';
      const result = parseTestOutput(output);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(2);
    });

    it('parses duration from (Nms) suffix', () => {
      const output = JEST_PASS_FILE + JEST_SUMMARY + '  ✓ timed test (15ms)\n';
      expect(parseTestOutput(output).tests[0].duration).toBe(15);
    });

    it('leaves duration undefined when absent', () => {
      const output = JEST_PASS_FILE + JEST_SUMMARY + '  ✓ no duration\n';
      expect(parseTestOutput(output).tests[0].duration).toBeUndefined();
    });

    it('jest tests have no filePath', () => {
      const output = JEST_PASS_FILE + JEST_SUMMARY + '  ✓ a test (1ms)\n';
      expect(parseTestOutput(output).tests[0].filePath).toBeUndefined();
    });

    it('returns unknown when PASS/FAIL present but no Tests:/Test Suites: line', () => {
      expect(parseTestOutput(JEST_PASS_FILE + '  ✓ a test (1ms)\n').ecosystem).toBe('unknown');
    });

    it('skipped is always 0 (jest has no skip indicator in this format)', () => {
      const output = JEST_PASS_FILE + JEST_SUMMARY + '  ✓ a test (1ms)\n';
      expect(parseTestOutput(output).skipped).toBe(0);
    });
  });

  describe('unknown / edge cases', () => {
    it('returns unknown for whitespace-only input', () => {
      expect(parseTestOutput('   \n\n  ').ecosystem).toBe('unknown');
    });

    it('returns unknown for output that matches no ecosystem', () => {
      expect(parseTestOutput('build succeeded\nno errors found\n').ecosystem).toBe('unknown');
    });
  });
});

describe('parseTestOutput — additional ecosystem edge cases', () => {
  it('vitest: detects by "vitest" keyword when "Test Files" is absent', () => {
    const output = 'Running Vitest\n  ✓ some test 1ms\n';
    expect(parseTestOutput(output).ecosystem).toBe('vitest');
  });

  it('vitest: converts seconds duration to milliseconds', () => {
    const output = ' Test Files  1 passed (1)\n  ✓ slow test 2.5s\n';
    expect(parseTestOutput(output).tests[0].duration).toBe(2500);
  });

  it('vitest: leaves filePath undefined for tests without a file extension in first segment', () => {
    const output = ' Test Files  1 passed (1)\n  ✓ standalone test 1ms\n';
    const t = parseTestOutput(output).tests[0];
    expect(t.filePath).toBeUndefined();
    expect(t.name).toBe('standalone test');
  });

  it('go: detected by "--- FAIL:" alone when no PASS lines exist', () => {
    expect(parseTestOutput('--- FAIL: TestBroken (0.00s)\n').ecosystem).toBe('go');
  });

  it('go: skipped is always 0', () => {
    const result = parseTestOutput('--- PASS: TestA (0.01s)\n--- FAIL: TestB (0.02s)\n');
    expect(result.skipped).toBe(0);
  });

  it('rust: tests have no duration field', () => {
    const output = 'test my_test ... ok\ntest result: ok.\n';
    expect(parseTestOutput(output).tests[0].duration).toBeUndefined();
  });

  it('pytest: parses "path::test PASSED" (status at end) format', () => {
    const output = 'tests/test_foo.py::test_something PASSED\n1 passed\n';
    const result = parseTestOutput(output);
    expect(result.ecosystem).toBe('pytest');
    expect(result.tests[0]).toMatchObject({ name: 'test_something', filePath: 'tests/test_foo.py', status: 'pass' });
  });

  it('pytest: parses SKIPPED status', () => {
    const output = 'tests/test_foo.py::test_skipped SKIPPED\n1 skipped\n';
    expect(parseTestOutput(output).tests[0].status).toBe('skip');
  });

  it('pytest: returns unknown when "::" is present but no test lines match', () => {
    expect(parseTestOutput('some::reference with no test status\n').ecosystem).toBe('unknown');
  });
});
