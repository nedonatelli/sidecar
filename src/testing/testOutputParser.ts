export type TestStatus = 'pass' | 'fail' | 'skip';

export interface ParsedTest {
  name: string;
  filePath?: string;
  status: TestStatus;
  duration?: number;
  errorMessage?: string;
}

export type TestEcosystem = 'vitest' | 'jest' | 'pytest' | 'go' | 'rust' | 'unknown';

export interface TestRunSummary {
  ecosystem: TestEcosystem;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  tests: ParsedTest[];
}

function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = raw.match(/^([\d.]+)ms$/);
  if (ms) return parseFloat(ms[1]);
  const s = raw.match(/^([\d.]+)s$/);
  if (s) return parseFloat(s[1]) * 1000;
  return undefined;
}

function parseVitest(output: string): TestRunSummary | null {
  if (!output.includes('Test Files') && !output.toLowerCase().includes('vitest')) return null;

  const tests: ParsedTest[] = [];
  // Match lines like:  ✓ src/foo.test.ts > describe > test name 5ms
  //                     × src/bar.test.ts > test name 2ms
  //                     ↓ src/baz.test.ts > skipped test
  const lineRe = /^\s+(✓|×|↓)\s+(.+?)(?:\s+([\d.]+(?:ms|s)))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    const symbol = m[1];
    const rest = m[2].trim();
    const durStr = m[3];
    const status: TestStatus = symbol === '✓' ? 'pass' : symbol === '×' ? 'fail' : 'skip';

    // The rest is "filePath > ... > testName" or just "testName"
    const parts = rest.split('>').map((p) => p.trim());
    let filePath: string | undefined;
    let name: string;
    if (parts.length > 1 && parts[0].includes('.')) {
      filePath = parts[0];
      name = parts.slice(1).join(' > ');
    } else {
      name = rest;
    }

    tests.push({ name, filePath, status, duration: parseDuration(durStr) });
  }

  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  const skipped = tests.filter((t) => t.status === 'skip').length;
  return { ecosystem: 'vitest', passed, failed, skipped, total: tests.length, tests };
}

function parseGo(output: string): TestRunSummary | null {
  if (!output.includes('--- PASS:') && !output.includes('--- FAIL:')) return null;

  const tests: ParsedTest[] = [];
  const lineRe = /^--- (PASS|FAIL): (\S+) \(([\d.]+)s\)/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    const status: TestStatus = m[1] === 'PASS' ? 'pass' : 'fail';
    const name = m[2];
    const duration = parseFloat(m[3]) * 1000;
    tests.push({ name, status, duration });
  }

  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  return { ecosystem: 'go', passed, failed, skipped: 0, total: tests.length, tests };
}

function parseRust(output: string): TestRunSummary | null {
  if (!output.includes('test result:')) return null;

  const tests: ParsedTest[] = [];
  const lineRe = /^test (.+?) \.\.\. (ok|FAILED|ignored)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    const name = m[1];
    const res = m[2];
    const status: TestStatus = res === 'ok' ? 'pass' : res === 'ignored' ? 'skip' : 'fail';
    tests.push({ name, status });
  }

  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  const skipped = tests.filter((t) => t.status === 'skip').length;
  return { ecosystem: 'rust', passed, failed, skipped, total: tests.length, tests };
}

function parsePytest(output: string): TestRunSummary | null {
  const hasSummaryLine = /\d+ passed/.test(output) || /\d+ failed/.test(output);
  const hasColonColon = output.includes('::');
  if (!hasSummaryLine && !hasColonColon) return null;

  // Require at least one ::  to confirm pytest format
  if (!hasColonColon) return null;

  const tests: ParsedTest[] = [];
  // Match: PASSED tests/foo.py::test_bar or tests/foo.py::test_bar PASSED
  const lineRe =
    /^(?:(PASSED|FAILED|SKIPPED)\s+(.+?::[\w\[\].,\s\-]+)|(.+?::[\w\[\].,\s\-]+)\s+(PASSED|FAILED|SKIPPED))$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    let statusStr: string;
    let fullPath: string;
    if (m[1]) {
      statusStr = m[1];
      fullPath = m[2].trim();
    } else {
      fullPath = m[3].trim();
      statusStr = m[4];
    }
    const status: TestStatus = statusStr === 'PASSED' ? 'pass' : statusStr === 'FAILED' ? 'fail' : 'skip';
    const sep = fullPath.lastIndexOf('::');
    const filePath = sep > 0 ? fullPath.slice(0, sep) : undefined;
    const name = sep > 0 ? fullPath.slice(sep + 2) : fullPath;
    tests.push({ name, filePath, status });
  }

  if (tests.length === 0) return null;

  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  const skipped = tests.filter((t) => t.status === 'skip').length;
  return { ecosystem: 'pytest', passed, failed, skipped, total: tests.length, tests };
}

function parseJest(output: string): TestRunSummary | null {
  // Jest prints PASS / FAIL on file summary lines, and ✓ / ✕ for individual tests
  const hasPassFail = /\b(PASS|FAIL)\b/.test(output);
  const hasJestSummary = /Tests:\s+\d+/.test(output) || /Test Suites:/.test(output);
  if (!hasPassFail || !hasJestSummary) return null;

  const tests: ParsedTest[] = [];
  // Match:    ✓ test name (5ms) or    ✕ test name (2ms)
  const lineRe = /^\s+(✓|✕)\s+(.+?)(?:\s+\((\d+)ms\))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    const symbol = m[1];
    const name = m[2].trim();
    const duration = m[3] ? parseInt(m[3], 10) : undefined;
    const status: TestStatus = symbol === '✓' ? 'pass' : 'fail';
    tests.push({ name, status, duration });
  }

  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  return { ecosystem: 'jest', passed, failed, skipped: 0, total: tests.length, tests };
}

export function parseTestOutput(output: string): TestRunSummary {
  const empty: TestRunSummary = { ecosystem: 'unknown', passed: 0, failed: 0, skipped: 0, total: 0, tests: [] };
  if (!output.trim()) return empty;

  return (
    parseVitest(output) ?? parseGo(output) ?? parseRust(output) ?? parsePytest(output) ?? parseJest(output) ?? empty
  );
}
