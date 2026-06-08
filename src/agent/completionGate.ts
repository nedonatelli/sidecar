import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolUseContentBlock, ToolResultContentBlock, ChatMessage } from '../ollama/types.js';

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
  /** True once the no-read-on-file-request reprompt has fired (fires at most once). */
  noReadRepromptFired: boolean;
  /** True once the no-shell-on-metric-query reprompt has fired (fires at most once). */
  noShellRepromptFired: boolean;
}

export function createGateState(): GateState {
  return {
    editedFiles: new Set(),
    testsRunForFiles: new Set(),
    projectTestsRan: false,
    lintObserved: false,
    gateInjections: 0,
    noReadRepromptFired: false,
    noShellRepromptFired: false,
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
  // Matches JS/TS test files (.test.ts, .spec.js, etc.), Go test files
  // (*_test.go), and both Python conventions: suffix (*_test.py) and
  // prefix (test_*.py — the standard pytest/unittest discovery pattern).
  const re = /\S+\.(?:test|spec)\.[tj]sx?|\S+_test\.go|\S+_test\.py|test_\S+\.py|tests\/\S+\.py/g;
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
  // Reset lintObserved so any lint run before this edit doesn't satisfy
  // the gate for the new change — the model must re-verify after editing.
  if (EDIT_TOOL_NAMES.has(tu.name)) {
    const raw = (tu.input.path ?? tu.input.file_path) as string | undefined;
    const p = normalizePath(raw);
    if (p) {
      state.editedFiles.add(p);
      state.lintObserved = false;
    }
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

  // Dedicated diagnostics tool — satisfies the lint requirement. This is
  // the primary post-edit verification tool (Rule 6 / get_diagnostics
  // description both say "call after every edit"). Without this case the
  // gate would reprompt for eslint/tsc even after the model correctly
  // called get_diagnostics.
  if (tu.name === 'get_diagnostics') {
    state.lintObserved = true;
    return;
  }

  // Raw shell — parse the command string for verification invocations.
  if (tu.name === 'run_command') {
    const cmd = String(tu.input.command ?? '');

    // Direct invocations of JS/TS linters (eslint, tsc), Python linters
    // (pylint, flake8, mypy, ruff, black), and Go linters (go vet,
    // golangci-lint, staticcheck), OR common npm/pnpm/yarn script names
    // that conventionally run lint or type-checking. We can't know what
    // "npm run lint" actually calls without parsing package.json, but the
    // naming convention is reliable enough to satisfy the gate.
    if (
      /\b(eslint|tsc|pylint|flake8|mypy|ruff|black|go\s+vet|golangci-lint|staticcheck)\b/.test(cmd) ||
      /\b(npm|pnpm|yarn|bun)\s+run\s+(lint|check|compile|build|typecheck|type-check)\b/.test(cmd)
    ) {
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
  /** Co-located test file exists on disk but was not edited this turn. */
  testNotUpdated?: string;
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
      // If tests ran (the model verified existing behaviour) but the test
      // file itself was not edited, new functionality may lack coverage.
      // Complements missingTest: that fires when tests weren't run at all;
      // this fires when tests ran but weren't updated for new additions.
      if (testFile && state.testsRunForFiles.has(testFile) && !state.editedFiles.has(testFile)) {
        findings.push({ file, testNotUpdated: testFile });
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
    'You are about to finish without verifying the changes you just made. ' +
      'Run the checks listed below RIGHT NOW — do not ask the user if they want you to run them, do not say "I will run the tests", just call the tool immediately. ' +
      'Report the actual tool output. Do not summarize, do not write a "Summary of Changes" message, ' +
      'and do not claim anything passes until you have seen real output. ' +
      'If a check fails, report the failure honestly — do not loop trying to fix it unless the fix is obvious and small.',
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

  const testUpdatePairs = findings.filter((f) => f.testNotUpdated);
  if (testUpdatePairs.length > 0) {
    lines.push('You edited source files but did not update their test files:');
    for (const p of testUpdatePairs) {
      lines.push(`  - ${p.file}  ->  ${p.testNotUpdated}`);
    }
    lines.push('Look at the existing test pattern in the test file and add cases that match it.');
  }

  if (attempt >= max) {
    lines.push(
      'This is your final gate attempt. If the checks cannot pass, stop and tell the ' +
        'user explicitly which check failed and why. Do not pretend success.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// No-read-on-file-request gate
//
// Fires once when the model responds without calling any file-reading tool
// that references the specific file(s) mentioned in the user's request.
// Catches the "filename pattern matching" failure mode where a model infers
// file contents from the filename alone instead of reading the actual file.
//
// Gap fixed (v0.112.4): previously used hasAnyReadToolCall() which returned
// true if the model called *any* read tool at any point — so a run_command
// for an unrelated file (e.g. `wc -l src/**/*.ts`) would suppress the gate
// even when package.json was never touched. Now checks per-file: each
// mentioned file must have had a read tool call whose input references it.
// ---------------------------------------------------------------------------

/** File extensions whose presence in a user message signals a file lookup is needed. */
const FILE_MENTION_RE = /\b[\w./\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|toml|yaml|yml|sh|cs|java|cpp|c|h)\b/gi;

/** Tools that constitute "the model read something for a specific file".
 *  run_command is included because `grep -n`, `jq`, `cat`, `head`, `tail`
 *  are all valid read paths — we check if the file name appears in the command. */
const READ_TOOL_NAMES = new Set(['read_file', 'grep', 'search_files', 'list_directory', 'run_command']);

// ---------------------------------------------------------------------------
// Workspace-metric query gate
//
// Fires once when the user asks a metric question about the workspace
// (file counts, line counts, dependency versions, etc.) but the model
// answered without running any shell command. These answers require live
// tool output — training-data guesses are reliably wrong about the current
// project state.
// ---------------------------------------------------------------------------

/**
 * Metric query words that signal the user wants a live workspace fact,
 * not a training-data inference.
 */
const WORKSPACE_METRIC_RE =
  /\b(how many|number of|count(ing)?|largest|biggest|longest|line count|lines in|wc\b|version (of|in)|size of)\b/i;

/**
 * Directory or config-file references that anchor a metric query to the
 * current workspace rather than a general question.
 */
const WORKSPACE_DIR_RE =
  /\b(src|tests?|lib|pkg|cmd)\b[/\\]|\bpackage\.json\b|\btsconfig\b|\bCargo\.toml\b|\bgo\.mod\b/i;

function firstUserText(messages: ChatMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (typeof b === 'object' && b !== null && 'type' in b && b.type === 'text' && 'text' in b) {
          return b.text as string;
        }
      }
    }
  }
  return '';
}

/**
 * Returns true if any assistant message contains a read-capable tool call
 * whose serialised input references `fileName` (case-insensitive).
 * This is a per-file check — a run_command for an unrelated path does NOT
 * satisfy this predicate.
 */
function hasReadToolCallForFile(messages: ChatMessage[], fileName: string): boolean {
  const lower = fileName.toLowerCase();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b !== 'object' || b === null || !('type' in b) || b.type !== 'tool_use') continue;
      if (!READ_TOOL_NAMES.has((b as { name: string }).name)) continue;
      const inputStr = JSON.stringify((b as { input?: unknown }).input ?? {}).toLowerCase();
      if (inputStr.includes(lower)) return true;
    }
  }
  return false;
}

/** Returns true if any assistant message contains a run_command tool call. */
function hasRunCommandCall(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_use' && 'name' in b) {
        if ((b as { name: string }).name === 'run_command') return true;
      }
    }
  }
  return false;
}

/**
 * Returns a reprompt string if the user's message mentions a specific file
 * path but no read tool call referencing that file was made. Checks each
 * mentioned file independently — a tool call for file A does not satisfy
 * the requirement for file B. Returns null when no reprompt is needed.
 */
export function buildNoReadReprompt(messages: ChatMessage[]): string | null {
  const userText = firstUserText(messages);
  if (!userText) return null;
  const fileMatches = userText.match(FILE_MENTION_RE);
  if (!fileMatches) return null;
  for (const file of fileMatches) {
    if (!hasReadToolCallForFile(messages, file)) {
      return (
        `You mentioned \`${file}\` but did not call read_file, grep, or any other file-reading tool before responding. ` +
        `Call \`read_file(path="${file}")\` now and answer from its actual contents — do not infer from the filename or training data.`
      );
    }
  }
  return null;
}

/**
 * Returns a reprompt string if the user asked a workspace metric question
 * (file count, line count, version, etc.) but the model answered without
 * running any shell command. Returns null when no reprompt is needed.
 */
export function buildNoShellReprompt(messages: ChatMessage[]): string | null {
  if (hasRunCommandCall(messages)) return null;
  const userText = firstUserText(messages);
  if (!userText) return null;
  if (!WORKSPACE_METRIC_RE.test(userText) || !WORKSPACE_DIR_RE.test(userText)) return null;
  return (
    'Your response answered a workspace metric question (file count, line count, version, etc.) ' +
    'without running a shell command. Your training data does not reflect the current state of this project. ' +
    'Run the appropriate command (find, wc -l, jq, rg --count, etc.) and answer from the actual output.'
  );
}
