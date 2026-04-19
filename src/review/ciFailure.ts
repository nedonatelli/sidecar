// ---------------------------------------------------------------------------
// CI Failure log parsing (v0.68 chunk 4).
//
// Pure primitive — no network, no VS Code. GitHub Actions raw logs are
// huge: timestamped line prefixes, nested `##[group]...##[endgroup]`
// sections, and `##[error]` annotations sprinkled inside whichever step
// tripped. This module reduces a raw log to the narrow slice a human
// or model needs to diagnose the failure:
//
//   - Which step failed (by group heading).
//   - The error line(s) emitted by GitHub Actions.
//   - The N lines of context immediately before each error.
//
// Output is structured (not markdown) so downstream callers can render
// for preview, send to the LLM as a compact failure prompt, or diff
// across runs without re-parsing.
// ---------------------------------------------------------------------------

export interface FailureBlock {
  /** Name of the step that contained the failure, parsed from the `##[group]` heading. */
  stepName: string;
  /** The `##[error]` lines inside the step, timestamp + annotation marker stripped. */
  errorLines: string[];
  /** Up to N lines immediately preceding the first error, in log order. */
  contextBefore: string[];
  /** Process exit code if the error mentioned one; otherwise undefined. */
  exitCode?: number;
}

export interface ExtractOptions {
  /** Lines of context to keep above each error block. Defaults to 20. */
  contextLines?: number;
  /** Max number of failure blocks to return. Defaults to 10 — long runs rarely need more. */
  maxBlocks?: number;
}

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/;
const GROUP_START = /^##\[group\](.*)$/;
const GROUP_END = /^##\[endgroup\]$/;
const ERROR_ANNOTATION = /^##\[error\](.*)$/;
const EXIT_CODE_HINT = /exit code (\d+)/i;

/**
 * Extract failure blocks from a raw GitHub Actions job log. Groups
 * (step scopes) that contain no `##[error]` annotations are ignored.
 */
export function extractFailures(log: string, options: ExtractOptions = {}): FailureBlock[] {
  const contextLines = options.contextLines ?? 20;
  const maxBlocks = options.maxBlocks ?? 10;

  // Strip timestamps once up front — every downstream matcher gets
  // cleaner input, and the output doesn't carry the 28-char prefix
  // through to the LLM or UI.
  const rawLines = log.split(/\r?\n/).map((line) => line.replace(TIMESTAMP_PREFIX, ''));

  const blocks: FailureBlock[] = [];
  let currentStep: string | null = null;
  let currentStepLines: string[] = [];
  const errorRanges: Array<{ stepName: string; lines: string[]; errorIndex: number }> = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    const groupMatch = line.match(GROUP_START);
    if (groupMatch) {
      currentStep = groupMatch[1].trim();
      currentStepLines = [];
      continue;
    }

    if (GROUP_END.test(line)) {
      // Step boundary — emit any collected errors for this step.
      // Works even when a step is skipped or has no errors; the
      // collection stays empty and nothing leaks to the output.
      currentStep = null;
      currentStepLines = [];
      continue;
    }

    if (currentStep !== null) {
      currentStepLines.push(line);
      const errorMatch = line.match(ERROR_ANNOTATION);
      if (errorMatch) {
        errorRanges.push({
          stepName: currentStep,
          lines: [...currentStepLines],
          errorIndex: currentStepLines.length - 1,
        });
      }
    } else {
      // Errors can also be emitted outside any group — GitHub sometimes
      // surfaces a top-level "##[error]Process completed..." after a
      // group has ended. Treat these as their own block with no step
      // name so downstream code doesn't need special handling.
      const errorMatch = line.match(ERROR_ANNOTATION);
      if (errorMatch) {
        errorRanges.push({
          stepName: '(top-level)',
          lines: [line],
          errorIndex: 0,
        });
      }
    }
  }

  // Collapse consecutive errors within the same step into a single
  // block — users don't want 40 separate entries when a test suite
  // fires 40 `##[error]` lines in a row.
  const merged: Array<{ stepName: string; lines: string[]; errorIndices: number[] }> = [];
  for (const range of errorRanges) {
    const last = merged[merged.length - 1];
    if (last && last.stepName === range.stepName && range.lines === range.lines) {
      // Same step: merge error indices into the latest block. The
      // `lines` array is the step's full accumulated content, so we
      // just append this error's index.
      last.lines = range.lines;
      last.errorIndices.push(range.errorIndex);
    } else {
      merged.push({
        stepName: range.stepName,
        lines: range.lines,
        errorIndices: [range.errorIndex],
      });
    }
  }

  for (const m of merged.slice(0, maxBlocks)) {
    const firstErrorIdx = m.errorIndices[0];
    const errorLineContents = m.errorIndices.map((idx) => {
      const match = m.lines[idx].match(ERROR_ANNOTATION);
      return match ? match[1] : m.lines[idx];
    });
    const contextStart = Math.max(0, firstErrorIdx - contextLines);
    const contextBefore = m.lines.slice(contextStart, firstErrorIdx);

    // Mine exit code from any error line that mentions it. Covers
    // the "Process completed with exit code 1." idiom GH Actions
    // emits for failed shell steps.
    let exitCode: number | undefined;
    for (const errText of errorLineContents) {
      const match = errText.match(EXIT_CODE_HINT);
      if (match) {
        exitCode = Number(match[1]);
        break;
      }
    }

    blocks.push({
      stepName: m.stepName,
      errorLines: errorLineContents,
      contextBefore,
      exitCode,
    });
  }

  return blocks;
}

/**
 * Render a list of failure blocks as compact markdown, suitable for
 * an editor preview or chat turn. Returns an empty string when there
 * are no failures so callers can trivially detect the clean case.
 */
export function formatFailuresMarkdown(blocks: readonly FailureBlock[]): string {
  if (blocks.length === 0) return '';
  const parts: string[] = [];
  for (const b of blocks) {
    parts.push(`### Step: ${b.stepName}`);
    if (b.exitCode !== undefined) {
      parts.push(`Exit code: ${b.exitCode}`);
    }
    parts.push('```');
    if (b.contextBefore.length > 0) {
      parts.push(...b.contextBefore);
    }
    for (const err of b.errorLines) {
      parts.push(`ERROR: ${err}`);
    }
    parts.push('```');
  }
  return parts.join('\n');
}
