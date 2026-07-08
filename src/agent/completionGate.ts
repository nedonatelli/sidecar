import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import { normalizePath, SOURCE_FILE_RE, TEST_FILE_RE } from './completionGate/pathUtil.js';

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

export interface GateState {
  /** Workspace-relative paths (forward-slashed) that were edited successfully this turn. */
  editedFiles: Set<string>;
  /** Test files that appeared in a run_tests / run_command invocation this turn. */
  testsRunForFiles: Set<string>;
  /** True if the whole test suite ran (e.g. `npm test`, `vitest` with no file). */
  projectTestsRan: boolean;
  /** Test files whose run actually PASSED (collected >0 tests, no failures). A
   * run that reported "no tests ran" / 0 collected / failures is in
   * testsRunForFiles but NOT here, so the behavioral gate isn't satisfied by a
   * test that verified nothing. */
  passingTestFiles: Set<string>;
  /** True if a whole-suite run PASSED. */
  projectTestsPassed: boolean;
  /** True if any eslint / tsc invocation was observed this turn. */
  lintObserved: boolean;
  /** How many times the gate has injected a reminder this turn. Capped to prevent loops. */
  gateInjections: number;
  /** True once the no-read-on-file-request reprompt has fired (fires at most once). */
  noReadRepromptFired: boolean;
  /** True once the no-shell-on-metric-query reprompt has fired (fires at most once). */
  noShellRepromptFired: boolean;
  /** True once the no-write-on-named-file reprompt has fired (fires at most once). */
  noFileWriteRepromptFired: boolean;
  /** True once the no-grounding-on-analysis-query reprompt has fired (fires at most once). */
  noGroundingRepromptFired: boolean;
  /** True once the unverified-claim reprompt has fired (fires at most once). */
  unverifiedClaimRepromptFired: boolean;
  /** How many times the syntax gate has reprompted this run (bounded). Optional for back-compat with test stubs. */
  syntaxGateInjections?: number;
  /**
   * Files the syntax gate is actively driving fixes on (the targets of the
   * most recent parse-failure reprompt). Edits to these are gate-supervised
   * fix attempts, not autonomous thrash, so the write-target cycle detector
   * exempts them — the gate's own injection cap bounds the fix loop. Optional
   * for back-compat with test stubs.
   */
  syntaxGateFixTargets?: Set<string>;
  /** How many times the behavioral-verification reprompt has fired this run (bounded).
   * A counter rather than a one-shot flag so the gate can re-fire when the model
   * "satisfies" it with a hollow test that never imports the module under test. */
  behavioralVerificationInjections?: number;
  /** True once the (non-blocking) change-impact advisory has been surfaced this
   * run. The advisory lists downstream dependents of edited exported symbols; it
   * fires at most once and never blocks completion. Optional for back-compat. */
  impactAdvisoryFired?: boolean;
  /** How many times the opt-in change-impact gate has blocked completion this
   * run (bounded to 1). Only fires when `sidecar.codeGraph.impactGate` is on and
   * edited exported symbols have unverified resolved dependents. Optional. */
  impactGateInjections?: number;
  /** True once the (non-blocking) numerical-contract advisory has fired. */
  numericalContractAdvisoryFired?: boolean;
  /** How many times the opt-in numerical-contract gate has blocked this run
   * (bounded to 1). Fires when `sidecar.numericalContracts.gate` is on and an
   * edited numerical kernel lacks a shape/dtype/unit contract. Optional. */
  numericalContractGateInjections?: number;
  /** True once the (non-blocking) analytic-bound advisory has fired. */
  analyticBoundAdvisoryFired?: boolean;
  /** How many times the opt-in analytic-bound gate has blocked this run
   * (bounded to 1). Fires when `sidecar.analyticBounds.gate` is on and an edited
   * kernel declares a value bound (e.g. `# bounds: 0 <= result <= 1`) that
   * nothing enforces or tests. Optional. */
  analyticBoundGateInjections?: number;
  /**
   * MCP mutation calls (tools without readOnlyHint: true) that succeeded but
   * have not been followed by a successful read-only call to the same server.
   * Keyed by an arbitrary unique key; values carry what the reprompt needs to
   * tell the model exactly which write to round-trip. Cleared per server when
   * a later read-only call to that server succeeds. Optional for back-compat
   * with test stubs.
   */
  mcpUnverifiedMutations?: Map<string, { server: string; tool: string; inputSummary: string }>;
  /** True once the MCP mutation-verify reprompt has fired (fires at most once). */
  mcpMutationRepromptFired?: boolean;
  /**
   * The user request that triggered THIS run, captured at loop init. The
   * request-based gates (no-read/no-shell/no-grounding/no-file-write/
   * unverified-claim) evaluate against this, NOT firstUserText(messages) —
   * in a continuing chat the first message is the original task, so anchoring
   * on it makes the gates fire on stale, already-satisfied requirements (a
   * "change the title" turn was judged against the original "build calculator"
   * prompt). Empty string falls back to firstUserText for back-compat.
   */
  currentUserRequest?: string;
}

export function createGateState(currentUserRequest = ''): GateState {
  return {
    currentUserRequest,
    editedFiles: new Set(),
    testsRunForFiles: new Set(),
    projectTestsRan: false,
    passingTestFiles: new Set(),
    projectTestsPassed: false,
    lintObserved: false,
    gateInjections: 0,
    noReadRepromptFired: false,
    noShellRepromptFired: false,
    noFileWriteRepromptFired: false,
    noGroundingRepromptFired: false,
    unverifiedClaimRepromptFired: false,
    behavioralVerificationInjections: 0,
    syntaxGateInjections: 0,
    syntaxGateFixTargets: new Set(),
    mcpUnverifiedMutations: new Map(),
    mcpMutationRepromptFired: false,
  };
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
 * Classify a test run's output. `empty` = the runner collected/ran zero tests
 * (pytest exit 5, "no tests ran", "Ran 0 tests") — it verified NOTHING and must
 * not satisfy the behavioral gate (dogfooding: qwen3.5 mangled its test file so
 * pytest collected 0 tests, and the empty run "passed" the gate, completing a
 * broken GUI). `fail` = ≥1 test failed / errored / non-zero exit. `pass` = tests
 * ran and all passed. `unknown` = unrecognized format (treated as not-passing).
 */
export function classifyTestResult(rawContent: string): 'pass' | 'fail' | 'empty' | 'unknown' {
  // Strip ANSI first. `run_tests` runs on a TTY, so output is colored AND can
  // contain cursor/erase codes (\x1b[K). An escape ending in a word char right
  // before a count ("\x1b[1m5 passed", "\x1b[K5 passed") kills the `\b` in
  // `\b\d+ passed\b`, so an unstripped pass reads as 'unknown' and the gate fires
  // on a genuinely passing run. Match any CSI sequence (ends in a letter) + OSC.
  const content = rawContent.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  const exitMatch = content.match(/exit code:\s*(\d+)/i);
  const exit = exitMatch ? parseInt(exitMatch[1], 10) : undefined;
  // Zero tests collected/ran — verified nothing.
  if (/no tests ran|ran 0 tests|collected 0 item|\b0 tests? (ran|passed|collected)/i.test(content) || exit === 5) {
    return 'empty';
  }
  // Failure: a NON-ZERO failed/error count ("5 passed, 0 failed" is a PASS — the
  // old `\b\d+ failed\b` matched "0 failed" and misread a pass as fail), a runner
  // failure word (pytest FAILED, go FAIL), an assertion/traceback, or non-zero exit.
  if (
    /\b[1-9]\d*\s+(failed|errors?)\b/i.test(content) ||
    /\bFAILED\b|\bFAIL\b|\bAssertionError\b|Traceback \(most recent/.test(content) ||
    (exit !== undefined && exit !== 0)
  ) {
    return 'fail';
  }
  // Pass: pytest/jest/vitest "N passed", mocha "N passing", unittest "OK", or exit 0.
  if (/\b[1-9]\d*\s+passed\b|\b[1-9]\d*\s+passing\b|(^|\s)OK\b|\ball tests passed\b/im.test(content) || exit === 0) {
    return 'pass';
  }
  return 'unknown';
}

/**
 * Record a completed tool call into the gate state. Call after the tool
 * has actually executed — errored tool results are ignored so a failed
 * eslint run doesn't falsely satisfy the lint requirement.
 */
/** Compact one-line rendering of a mutation's input so the verify reprompt can
 * name the exact fields the model must round-trip. Bounded so a huge payload
 * (e.g. a full document body) can't blow up the injection. */
const MAX_MCP_INPUT_SUMMARY_CHARS = 300;
function summarizeMcpInput(input: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = `{ ${Object.keys(input).join(', ')} }`;
  }
  return json.length > MAX_MCP_INPUT_SUMMARY_CHARS ? json.slice(0, MAX_MCP_INPUT_SUMMARY_CHARS) + '…' : json;
}

/**
 * Reprompt for MCP writes that were never read back. Fire-and-trust is the
 * failure mode: the tool returned success, but nothing confirmed the fields
 * actually landed on the external system (partial writes, silently dropped
 * fields, server-side transformations). Returns null when every mutation was
 * verified or none happened.
 */
export function buildMcpMutationVerifyReprompt(state: GateState): string | null {
  const mutations = state.mcpUnverifiedMutations;
  if (!mutations || mutations.size === 0) return null;

  const lines = [...mutations.values()].map((m) => `- ${m.tool} (server "${m.server}") — input: ${m.inputSummary}`);
  return (
    '⛔ Unverified external write(s). You changed state on an external system via MCP but never read it back:\n\n' +
    lines.join('\n') +
    '\n\nBefore finishing:\n' +
    '1. Call a read tool from the same MCP server to fetch the resource(s) you modified.\n' +
    '2. Compare every field you set against the value the read returns.\n' +
    '3. If all fields match, finish and say so. If anything differs — or the server has no read tool — do NOT ' +
    'claim success: report exactly which fields could not be verified, and if the resource supports a ' +
    'draft/unpublished state, leave it there rather than publishing an unverified change.'
  );
}

export function recordToolCall(
  state: GateState,
  tu: ToolUseContentBlock,
  result: ToolResultContentBlock,
  mcpToolMeta?: (name: string) => { server: string; readOnly: boolean } | undefined,
): void {
  if (result.is_error) return;
  const resultText = typeof result.content === 'string' ? result.content : '';

  // delegate_to_mcp — the delegation path calls a server tool via
  // callServerTool, bypassing the mcp_* names tracked below, so a delegated
  // task that writes to an external system would be invisible to the verify
  // discipline. Delegated tasks are conservatively mutations (their whole
  // point is to DO something). delegateToMcp reports every failure as plain
  // content (never is_error), so success is detected by the <mcp_tool_output>
  // boundary wrap — only a genuine server response carries it.
  if (tu.name === 'delegate_to_mcp') {
    const server = typeof tu.input.server === 'string' ? tu.input.server.trim() : '';
    if (server && resultText.includes('<mcp_tool_output')) {
      const mutations = (state.mcpUnverifiedMutations ??= new Map());
      mutations.set(tu.id, { server, tool: 'delegate_to_mcp', inputSummary: summarizeMcpInput(tu.input) });
    }
    return;
  }

  // MCP tools — mutation discipline bookkeeping. A successful call to a tool
  // classified as a mutation (readOnlyHint annotation / read-verb fallback)
  // is an external write we can't see; it stays "unverified" until a later
  // successful read-only call to the SAME server gives the model round-trip
  // evidence. Calls are processed in issue order, so a read only verifies
  // mutations recorded before it.
  if (tu.name.startsWith('mcp_') && mcpToolMeta) {
    const meta = mcpToolMeta(tu.name);
    if (meta) {
      const mutations = (state.mcpUnverifiedMutations ??= new Map());
      if (meta.readOnly) {
        for (const [key, m] of mutations) {
          if (m.server === meta.server) mutations.delete(key);
        }
      } else {
        mutations.set(tu.id, {
          server: meta.server,
          tool: tu.name,
          inputSummary: summarizeMcpInput(tu.input),
        });
      }
    }
    return;
  }

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
    const passed = classifyTestResult(resultText) === 'pass';
    const file = tu.input.file as string | undefined;
    if (file) {
      const p = normalizePath(file);
      if (p) {
        state.testsRunForFiles.add(p);
        if (passed) state.passingTestFiles.add(p);
      }
    } else {
      state.projectTestsRan = true;
      if (passed) state.projectTestsPassed = true;
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
      const passed = classifyTestResult(resultText) === 'pass';
      const args = testMatch[2] || '';
      const files = extractTestFiles(args);
      if (files.length > 0) {
        for (const f of files) {
          const p = normalizePath(f);
          if (p) {
            state.testsRunForFiles.add(p);
            if (passed) state.passingTestFiles.add(p);
          }
        }
      } else {
        state.projectTestsRan = true;
        if (passed) state.projectTestsPassed = true;
      }
    }

    // `npm test` / `yarn test` / `pnpm test` — whole-suite invocation.
    if (/\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b/.test(cmd)) {
      state.projectTestsRan = true;
      if (classifyTestResult(resultText) === 'pass') state.projectTestsPassed = true;
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
    // Lead with get_diagnostics — the language-agnostic post-edit check that
    // satisfies this requirement for every language. Only suggest eslint for
    // files it can actually lint (JS/TS); telling the model to run `npx eslint
    // calculator.py` is wrong and dogfooding showed it flailing on that advice
    // until the gate exhausted. Python/Go/Rust get the diagnostics call only.
    lines.push('You have not run a static check on your edits this turn. Call:');
    lines.push('  get_diagnostics   (checks every edited file — works for all languages)');
    const jstsFiles = lintFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
    if (jstsFiles.length > 0) {
      lines.push(`Or, for the JS/TS files specifically: run_command with command: npx eslint ${jstsFiles.join(' ')}`);
    }
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
// Re-exports: the reprompt-gate builders moved into ./completionGate/ for size.
// External importers keep using `./completionGate.js` unchanged.
// ---------------------------------------------------------------------------
export * from './completionGate/reprompts.js';
export * from './completionGate/behavioralReprompt.js';
