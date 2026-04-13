import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';

/**
 * Completion gate — a deterministic verification barrier that fires when the
 * agent tries to terminate without running tests / lint for files it edited.
 *
 * Failure mode it catches: the model confidently reports a change as "ready
 * for use" without ever running the checks it's claiming pass. The gate
 * tracks edits and verification tool calls across a turn and, at the natural
 * termination point, refuses to let the loop exit until the claims match
 * what actually ran in tool results.
 *
 * The gate catches *lies about verification*. It cannot catch lies about
 * code structure (e.g. "I removed the variable" when the variable was
 * commented out) — those require prompt-level guardrails, not this one.
 */

/** Edit-capable tools whose inputs carry a file path we should track. */
const EDIT_TOOL_NAMES = new Set(['write_file', 'edit_file']);

/** Source files we care about verifying. Non-matching files are skipped. */
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

/** Test file convention — these don't need their own tests. */
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

export interface GateState {
  /** Workspace-relative paths (forward-slashed) that were edited successfully this turn. */
  editedFiles: Set<string>;
  /** Test files that appeared in a run_tests / run_command invocation this turn. */
  testsRunForFiles: Set<string>;
  /** True if the whole test suite ran (e.g. `npm test`, `vitest` with no file). */
  projectTestsRan: boolean;
  /** True if any eslint / tsc invocation was observed this turn. */
  lintObserved: boolean;
  /** How many times the gate has injected a reminder this turn. Capped to prevent loops. */
  gateInjections: number;
}

export function createGateState(): GateState {
  return {
    editedFiles: new Set(),
    testsRunForFiles: new Set(),
    projectTestsRan: false,
    lintObserved: false,
    gateInjections: 0,
  };
}

/**
 * Normalize a file path to workspace-relative forward-slashed form.
 * Returns null if the path is outside the workspace or can't be resolved.
 */
function normalizePath(p: string | undefined | null): string | null {
  if (!p) return null;
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    // Fall back to forward-slash-only in test environments without a workspace.
    return p.split(path.sep).join('/');
  }
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Extract file arguments from a test runner command line. Conservatively
 * matches only canonical test filename patterns so we don't confuse a test
 * filter string with a file path.
 */
function extractTestFiles(args: string): string[] {
  const re = /\S+\.(?:test|spec)\.[tj]sx?|\S+_test\.go|\S+_test\.py|tests\/\S+\.py/g;
  return args.match(re) || [];
}

/**
 * Record a completed tool call into the gate state. Call after the tool
 * has actually executed — errored tool results are ignored so a failed
 * eslint run doesn't falsely satisfy the lint requirement.
 */
export function recordToolCall(state: GateState, tu: ToolUseContentBlock, result: ToolResultContentBlock): void {
  if (result.is_error) return;

  // Edit tools — track the path(s) they mutated.
  if (EDIT_TOOL_NAMES.has(tu.name)) {
    const raw = (tu.input.path ?? tu.input.file_path) as string | undefined;
    const p = normalizePath(raw);
    if (p) state.editedFiles.add(p);
    return;
  }

  // Dedicated test tool.
  if (tu.name === 'run_tests') {
    const file = tu.input.file as string | undefined;
    if (file) {
      const p = normalizePath(file);
      if (p) state.testsRunForFiles.add(p);
    } else {
      state.projectTestsRan = true;
    }
    return;
  }

  // Raw shell — parse the command string for verification invocations.
  if (tu.name === 'run_command') {
    const cmd = String(tu.input.command ?? '');

    if (/\b(eslint|tsc)\b/.test(cmd)) {
      state.lintObserved = true;
    }

    const testMatch = cmd.match(/\b(vitest|jest|pytest|mocha|go\s+test)\b([^|;&]*)/);
    if (testMatch) {
      const args = testMatch[2] || '';
      const files = extractTestFiles(args);
      if (files.length > 0) {
        for (const f of files) {
          const p = normalizePath(f);
          if (p) state.testsRunForFiles.add(p);
        }
      } else {
        state.projectTestsRan = true;
      }
    }

    // `npm test` / `yarn test` / `pnpm test` — whole-suite invocation.
    if (/\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b/.test(cmd)) {
      state.projectTestsRan = true;
    }
  }
}

export interface GateFinding {
  file: string;
  missingTest?: string;
  needsLint?: boolean;
}

/**
 * Locate a colocated test file next to `file`. Tries `.test.<ext>` then
 * `.spec.<ext>` in the same directory. Returns workspace-relative path or
 * null if none exists. Async because it hits the filesystem.
 */
export async function findColocatedTest(file: string): Promise<string | null> {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;

  const ext = path.extname(file);
  if (!ext) return null;
  const base = file.slice(0, -ext.length);
  const candidates = [`${base}.test${ext}`, `${base}.spec${ext}`];

  for (const candidate of candidates) {
    try {
      await workspace.fs.stat(Uri.file(path.join(root, candidate)));
      return candidate;
    } catch {
      // not found — try next
    }
  }
  return null;
}

/**
 * Evaluate the gate state against the edited files and return any
 * verification gaps. Empty array means the agent is free to terminate.
 */
export async function checkCompletionGate(state: GateState): Promise<GateFinding[]> {
  const findings: GateFinding[] = [];

  for (const file of state.editedFiles) {
    if (!SOURCE_FILE_RE.test(file)) continue;
    if (file.endsWith('.d.ts')) continue;
    // A test file edit doesn't obligate *its own* test run — the next
    // rule covers whether the edited file needs lint, which still applies.
    const isTestFile = TEST_FILE_RE.test(file);

    if (!isTestFile && !state.projectTestsRan) {
      const testFile = await findColocatedTest(file);
      if (testFile && !state.testsRunForFiles.has(testFile)) {
        findings.push({ file, missingTest: testFile });
      }
    }

    if (!state.lintObserved) {
      // Lint applies to both source and test files since both are linted.
      findings.push({ file, needsLint: true });
    }
  }

  return findings;
}

/**
 * Build the synthetic user-message text that the gate injects back into
 * the agent loop. The wording is deliberately strict about not summarizing
 * or claiming completion — those are the exact failure modes the gate
 * exists to catch.
 */
export function buildGateInjection(findings: GateFinding[], attempt: number, max: number): string {
  const lines: string[] = [];
  lines.push(`[Completion gate — attempt ${attempt} of ${max}]`);
  lines.push('');
  lines.push(
    'You are about to finish without verifying the changes you just made. Before ' +
      'declaring completion, run the checks listed below and report their actual output ' +
      'as tool results. Do not summarize, do not write a "Summary of Changes" message, ' +
      'and do not claim anything passes until you have seen real output. If a check ' +
      'fails, fix the underlying code and re-run — do not edit the test to match broken code.',
  );
  lines.push('');

  const lintFiles = [...new Set(findings.filter((f) => f.needsLint).map((f) => f.file))];
  if (lintFiles.length > 0) {
    lines.push('Lint has not run this turn. Run:');
    lines.push(`  run_command with command: npx eslint ${lintFiles.join(' ')}`);
    lines.push('');
  }

  const testPairs = findings.filter((f) => f.missingTest);
  if (testPairs.length > 0) {
    lines.push('Tests for the files you edited have not run this turn:');
    for (const p of testPairs) {
      lines.push(`  - ${p.file}  ->  ${p.missingTest}`);
    }
    const uniqueTests = [...new Set(testPairs.map((p) => p.missingTest!))];
    lines.push('Run one of:');
    for (const t of uniqueTests) {
      lines.push(`  - run_tests with file: ${t}`);
    }
    lines.push(`  - run_command with command: npx vitest run ${uniqueTests.join(' ')}`);
    lines.push('');
  }

  if (attempt >= max) {
    lines.push(
      'This is your final gate attempt. If the checks cannot pass, stop and tell the ' +
        'user explicitly which check failed and why. Do not pretend success.',
    );
  }

  return lines.join('\n');
}
