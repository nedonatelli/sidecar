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
});
