// ---------------------------------------------------------------------------
// Pure GitHub Actions log parser.
//
// No VS Code or Node.js I/O — all inputs and outputs are strings/arrays,
// so every function is unit-testable without mocks.
//
// Pipeline:
//   1. Optionally tail the raw log to maxBytes (failures are at the end).
//   2. Strip ANSI codes and GHA timestamp prefixes from each line.
//   3. Walk GHA group/endgroup/error markers to extract step sections.
//   4. Identify failed steps (those with ##[error] markers, or the last
//      step when the job fails without explicit step errors).
//   5. Within each failed step, window around failure-pattern lines so
//      only the relevant assertion / error context is returned.
// ---------------------------------------------------------------------------

export interface FailedStep {
  name: string;
  /** Relevant lines from the step — ANSI stripped, timestamps removed. */
  errorLines: string[];
}

export interface ParsedJobLog {
  failedSteps: FailedStep[];
  /** True when the raw log exceeded maxBytes and was tailed. */
  truncated: boolean;
  rawLineCount: number;
}

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]/g;
// GHA prepends an ISO timestamp + space to every line.
const GHA_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;
// GHA workflow-command lines: ##[group]name, ##[endgroup], ##[error]msg …
const GHA_CMD_RE = /^##\[(\w+)](.*)/;

// ---------------------------------------------------------------------------
// Low-level string helpers (exported for tests)
// ---------------------------------------------------------------------------

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function stripGhaTimestamp(line: string): string {
  return line.replace(GHA_TS_RE, '');
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw GitHub Actions job log into its failed steps.
 *
 * @param rawLog   Full text from `GET /repos/:owner/:repo/actions/jobs/:id/logs`.
 * @param maxBytes Soft cap. When exceeded, the **tail** of the log is used —
 *                 failures always land at the end of the output, so truncating
 *                 the head preserves the most useful content.
 */
export function parseJobLog(rawLog: string, maxBytes = 4_000_000): ParsedJobLog {
  let log = rawLog;
  let truncated = false;

  if (Buffer.byteLength(log, 'utf8') > maxBytes) {
    truncated = true;
    const bytes = Buffer.from(log, 'utf8');
    const tail = bytes.subarray(bytes.length - maxBytes);
    log = tail.toString('utf8');
    // Drop the first (likely partial) line produced by the mid-byte cut.
    const firstNl = log.indexOf('\n');
    if (firstNl >= 0) log = log.slice(firstNl + 1);
  }

  const rawLines = log.split('\n');
  const rawLineCount = rawLines.length;

  // Walk lines and bucket them into GHA step sections.
  const steps: Array<{ name: string; lines: string[]; hasError: boolean }> = [];
  let current: (typeof steps)[number] | null = null;

  for (const rawLine of rawLines) {
    const line = stripGhaTimestamp(rawLine);
    const cmdMatch = GHA_CMD_RE.exec(line);

    if (cmdMatch) {
      const [, cmd, arg] = cmdMatch;
      if (cmd === 'group') {
        current = { name: stripAnsi(arg.trim()), lines: [], hasError: false };
        steps.push(current);
      } else if (cmd === 'endgroup') {
        current = null;
      } else if (cmd === 'error') {
        if (current) {
          current.hasError = true;
          current.lines.push(`ERROR: ${stripAnsi(arg)}`);
        }
      }
      // Skip ##[warning], ##[notice], ##[debug] — not useful for diagnosis.
      continue;
    }

    if (current) {
      current.lines.push(stripAnsi(line));
    }
  }

  // Determine which steps failed. Prefer steps with explicit ##[error] markers;
  // if none exist (runner-level exit code failure with no step error annotation),
  // fall back to the last step.
  const withError = steps.filter((s) => s.hasError);
  const failedRaw = withError.length > 0 ? withError : steps.slice(-1);

  const failedSteps: FailedStep[] = failedRaw.map((s) => ({
    name: s.name,
    errorLines: extractRelevantLines(s.lines),
  }));

  return { failedSteps, truncated, rawLineCount };
}

// ---------------------------------------------------------------------------
// Relevant-line extraction
//
// Within a failed step we want only the lines that show WHY it failed —
// not the full output (which can be thousands of lines for a test suite).
//
// Strategy:
//   1. Trim leading/trailing blank lines.
//   2. If the result fits within MAX_LINES_PER_STEP, return it whole.
//   3. Otherwise find every line matching a known failure pattern, open a
//      context window (BEFORE lines before, AFTER lines after), and emit
//      those windows with "[… omitted …]" gap markers between them.
//   4. If no failure patterns matched, return the tail (most recent output
//      is most useful when we can't identify the specific failure line).
// ---------------------------------------------------------------------------

const MAX_LINES_PER_STEP = 120;
const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 15;

// Ordered from most-specific to most-generic to minimise false positives.
const FAILURE_PATTERNS: RegExp[] = [
  // vitest / jest
  /^\s*FAIL\s+\S/,
  /^\s*[✕×●]\s/u,
  /^\s*AssertionError/,
  /^\s*Expected\s*:/,
  /^\s*Received\s*:/,
  /^\s*\+\s+(expected|received)/i,
  // pytest
  /^(FAILED|ERROR)\s+\S/,
  /^\s*E\s{3}/,
  // go test
  /^--- FAIL:/,
  /^FAIL\t/,
  // cargo test
  /^test .+ \.\.\. FAILED$/,
  /^---- .+ stdout ----$/,
  // rustc / tsc / eslint compile errors
  /\berror\[E\d+\]/,
  /^\S+:\d+:\d+: error:/,
  // generic "Error: ..." at line start
  /^(Error|TypeError|ReferenceError|SyntaxError):/,
];

export function isFailureLine(line: string): boolean {
  return FAILURE_PATTERNS.some((re) => re.test(line));
}

function extractRelevantLines(lines: string[]): string[] {
  // Trim leading/trailing blank lines.
  let lo = 0;
  while (lo < lines.length && lines[lo].trim() === '') lo++;
  let hi = lines.length - 1;
  while (hi > lo && lines[hi].trim() === '') hi--;
  const trimmed = lines.slice(lo, hi + 1);

  if (trimmed.length <= MAX_LINES_PER_STEP) return trimmed;

  // Build a boolean mask: true = this line belongs to a failure window.
  const inWindow = new Array<boolean>(trimmed.length).fill(false);
  for (let i = 0; i < trimmed.length; i++) {
    if (!isFailureLine(trimmed[i])) continue;
    const start = Math.max(0, i - WINDOW_BEFORE);
    const end = Math.min(trimmed.length - 1, i + WINDOW_AFTER);
    for (let j = start; j <= end; j++) inWindow[j] = true;
  }

  const result: string[] = [];
  let gapOpen = false;

  for (let i = 0; i < trimmed.length; i++) {
    if (inWindow[i]) {
      if (gapOpen) {
        result.push('[… lines omitted …]');
        gapOpen = false;
      }
      result.push(trimmed[i]);
    } else {
      gapOpen = true;
    }
  }

  // No known pattern matched — return the tail so the most recent output
  // (which usually contains the error) is always surfaced.
  if (result.length === 0) {
    return ['[… earlier output omitted …]', ...trimmed.slice(-MAX_LINES_PER_STEP)];
  }

  return result;
}
