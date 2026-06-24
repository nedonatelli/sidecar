import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolUseContentBlock, ToolResultContentBlock, ChatMessage } from '../ollama/types.js';
import { extractCitedPaths, pathVariants, hasUnverifiedHedge } from './citationCheck.js';

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
  /** True once the behavioral-verification reprompt has fired (fires at most once). */
  behavioralVerificationRepromptFired?: boolean;
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
    lintObserved: false,
    gateInjections: 0,
    noReadRepromptFired: false,
    noShellRepromptFired: false,
    noFileWriteRepromptFired: false,
    noGroundingRepromptFired: false,
    unverifiedClaimRepromptFired: false,
    behavioralVerificationRepromptFired: false,
    syntaxGateInjections: 0,
    syntaxGateFixTargets: new Set(),
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

export function firstUserText(messages: ChatMessage[]): string {
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
 * The most recent user message text — the request that triggered the current
 * run. Captured at loop init (before any synthetic gate injection is appended)
 * so it reflects the user's actual current-turn ask, not the first message of a
 * long conversation. See GateState.currentUserRequest.
 */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
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

/**
 * True if `fileName` (as mentioned in the user's request) was written/edited
 * by the agent this session. Matches an editedFiles entry by basename or path
 * suffix — editedFiles stores the path the write tool used ("calculator.py" or
 * "src/calculator.py"); the mention may be bare ("calculator.py").
 */
function fileWasEdited(fileName: string, editedFiles?: ReadonlySet<string>): boolean {
  if (!editedFiles || editedFiles.size === 0) return false;
  const base = fileName.split('/').pop()!.toLowerCase();
  for (const edited of editedFiles) {
    const e = edited.toLowerCase();
    if (e === base || e.endsWith('/' + base) || e === fileName.toLowerCase()) return true;
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
export function buildNoReadReprompt(
  messages: ChatMessage[],
  editedFiles?: ReadonlySet<string>,
  requestText?: string,
): string | null {
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  const fileMatches = userText.match(FILE_MENTION_RE);
  if (!fileMatches) return null;
  for (const file of fileMatches) {
    // The agent authored this file this session — writing implies knowing its
    // contents, so a read is redundant. Skips the "build calculator.py" case
    // where the user names the file with write intent and the agent creates +
    // tests it but never reads it. (Dogfooding fired a pointless read+describe
    // cycle on a freshly-written, already-tested file.)
    if (fileWasEdited(file, editedFiles)) continue;
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
export function buildNoShellReprompt(messages: ChatMessage[], requestText?: string): string | null {
  if (hasRunCommandCall(messages)) return null;
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!WORKSPACE_METRIC_RE.test(userText) || !WORKSPACE_DIR_RE.test(userText)) return null;
  return (
    'Your response answered a workspace metric question (file count, line count, version, etc.) ' +
    'without running a shell command. Your training data does not reflect the current state of this project. ' +
    'Run the appropriate command (find, wc -l, jq, rg --count, etc.) and answer from the actual output.'
  );
}

// ---------------------------------------------------------------------------
// No-grounding-on-analysis-query gate
//
// Fires once when the user asks for an open-ended review/evaluation of the
// codebase or its design ("review the architecture", "assess this codebase")
// but the model answered without calling ANY grounding tool — no read_file,
// grep, search_files, list_directory, project_knowledge_search, or
// run_command. These questions name no specific file, so the no-read gate
// never trips; the model is free to answer from injected SIDECAR.md sections
// + the file tree + RAG context alone. The result is generic, training-data
// architecture advice that hallucinates absent files and recommends patterns
// the project already implements. This gate forces at least one look at the
// actual code before a verdict.
// ---------------------------------------------------------------------------

/** Analysis verbs that signal the user wants an evaluation of real code. */
const ANALYSIS_VERB_RE = /\b(review|evaluat(e|ing|ion)|assess|audit|critiqu(e|ing)|analy[sz]e|appraise|inspect)\b/i;

/** Targets that anchor an analysis query to this workspace's code/design. */
const ANALYSIS_TARGET_RE =
  /\b(architecture|design|codebase|code\s?base|structure|implementation|module|component|this (project|repo|repository|code|extension)|the (project|repo|repository|codebase|code))\b/i;

/** True when the message asks for an evaluation/review of real code in this workspace. */
export function isAnalysisRequest(text: string): boolean {
  return ANALYSIS_VERB_RE.test(text) && ANALYSIS_TARGET_RE.test(text);
}

/** Tools that constitute "the model actually looked at the code". */
const GROUNDING_TOOL_NAMES = new Set([
  'read_file',
  'grep',
  'search_files',
  'list_directory',
  'run_command',
  'project_knowledge_search',
]);

/** Returns true if any assistant message made a grounding tool call. */
function hasAnyGroundingToolCall(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b !== 'object' || b === null || !('type' in b) || b.type !== 'tool_use') continue;
      if (GROUNDING_TOOL_NAMES.has((b as { name: string }).name)) return true;
    }
  }
  return false;
}

/**
 * Returns a reprompt string if the user asked for an open-ended review or
 * evaluation of the codebase/design but the model answered without calling
 * any grounding tool. Returns null when no reprompt is needed.
 */
export function buildNoGroundingReprompt(messages: ChatMessage[], requestText?: string): string | null {
  if (hasAnyGroundingToolCall(messages)) return null;
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!isAnalysisRequest(userText)) return null;
  return (
    'You produced a review of this codebase without reading any of it — no read_file, grep, ' +
    'project_knowledge_search, or other grounding tool was called. Your training data does not ' +
    'include this project, so every claim about what the code does, lacks, or should add is a guess. ' +
    'Inspect the relevant modules first (grep for the patterns you intend to comment on, read the files ' +
    'that own them), then ground each point in what you actually found — cite the file/symbol. ' +
    'Before recommending any pattern, search for it: do not advise adding something the project already has.'
  );
}

// ---------------------------------------------------------------------------
// Unverified-claim gate (scaffolding roadmap V1)
//
// Even a grounded, structured review can ship fabricated citations: a path
// that doesn't exist (`src/context/context.ts` when the real file is
// `src/agent/context.ts`), or findings the model itself hedges as unverified
// ("I cannot verify…", "implied usage…"). This gate runs on an analysis/review
// answer, extracts the file paths it cites, checks they resolve on disk, and
// reprompts once when any are fabricated or any hedge phrase admits an
// unverified claim. Scoped to analysis intent so it never flags a legitimate
// "create src/new.ts" proposal in a normal coding task.
// ---------------------------------------------------------------------------

/** Return the text of the most recent assistant message (the answer being gated). */
function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'text' && 'text' in b)
        .map((b) => (b as { text: string }).text)
        .join('\n');
    }
  }
  return '';
}

/** Default existence check against the active workspace. Injectable for tests. */
async function defaultFileExists(relPath: string): Promise<boolean> {
  const root = workspace.workspaceFolders?.[0]?.uri;
  if (!root) return false;
  try {
    await workspace.fs.stat(Uri.joinPath(root, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a reprompt when an analysis/review answer cites file paths that don't
 * resolve on disk, or contains hedge phrases admitting an unverified claim.
 * Returns null when the answer is clean (or the request wasn't an analysis).
 * `fileExists` is injectable so tests don't touch a real workspace.
 */
export async function buildUnverifiedClaimReprompt(
  messages: ChatMessage[],
  fileExists: (relPath: string) => Promise<boolean> = defaultFileExists,
  requestText?: string,
): Promise<string | null> {
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!isAnalysisRequest(userText)) return null;

  const answer = lastAssistantText(messages);
  if (!answer) return null;

  const fabricated: string[] = [];
  const seen = new Set<string>();
  for (const cited of extractCitedPaths(answer)) {
    const rel = normalizePath(cited);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    let resolved = false;
    for (const v of pathVariants(rel)) {
      if (await fileExists(v)) {
        resolved = true;
        break;
      }
    }
    if (!resolved) fabricated.push(rel);
  }

  const hedged = hasUnverifiedHedge(answer);
  if (fabricated.length === 0 && !hedged) return null;

  const parts: string[] = [];
  if (fabricated.length > 0) {
    parts.push(
      `Your review cites ${fabricated.length === 1 ? 'a path that does not exist' : 'paths that do not exist'} in ` +
        `this workspace: ${fabricated.map((f) => `\`${f}\``).join(', ')}. A citation must be a file you actually ` +
        `opened. Locate the correct path (grep / list_directory), read it, and fix or remove the reference — do not ` +
        `cite a file you have not read.`,
    );
  }
  if (hedged) {
    parts.push(
      'Your answer contains an unverified claim (it says something is "implied", "assumed", or that you "cannot ' +
        'verify" / answered "without reading"). Open the relevant file and confirm the claim, or delete the finding. ' +
        'Do not present an inference as a finding.',
    );
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// No-write-on-named-file gate
//
// Fires once when the user's message explicitly names a file AND uses
// write-intent language (add, extend, update, modify, edit, implement,
// create, fix, change) near that file, but the agent calls done without
// having written to it. Catches the "finish after the first part" failure
// mode where a model implements the feature but skips writing the test file
// (or vice versa) even though the user named both.
//
// Conservative by design: only fires when write-intent language is present
// in the message so read-only requests ("read src/foo.ts and explain…") do
// not trigger a spurious reprompt.
// ---------------------------------------------------------------------------

/**
 * Write-intent verbs that signal the user wants the named file to be
 * modified (not just read for context).
 */
const WRITE_INTENT_RE =
  /\b(add|extend|update|modify|edit|implement|create|fix|change|write|insert|append|refactor|rename|delete|remove)\b/i;

/**
 * Returns a reprompt string listing files that were mentioned in the user's
 * message with write intent but were never written by the agent. Returns
 * null when no reprompt is needed.
 */
export async function buildNoFileWriteReprompt(
  messages: ChatMessage[],
  editedFiles: Set<string>,
  requestText?: string,
  fileExists: (relPath: string) => Promise<boolean> = defaultFileExists,
): Promise<string | null> {
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!WRITE_INTENT_RE.test(userText)) return null;

  const mentioned = userText.match(FILE_MENTION_RE);
  if (!mentioned) return null;

  // Normalise mentioned paths: strip leading backticks/quotes, drop pure
  // directory tokens (no extension), collapse to basename for matching so
  // "src/deps/semver.test.ts" matches an editedFiles entry of "semver.test.ts"
  // regardless of how the sandbox rooted it.
  const unwritten: string[] = [];
  for (const raw of mentioned) {
    const clean = raw.replace(/[`'"]/g, '');
    // Skip if the agent wrote any path that ends with the same basename.
    const base = clean.split('/').pop() ?? clean;
    const wasWritten =
      editedFiles.has(clean) ||
      editedFiles.has(base) ||
      [...editedFiles].some((f) => f.endsWith('/' + base) || f === base);
    if (wasWritten) continue;
    // Skip files that already exist on disk: the gate's job is to catch a named
    // file the user asked to CREATE that never got created. An existing file is
    // almost always a read-only dependency referenced by the task ("wire to the
    // functions already in calculator.py"), not a missing write target.
    // Dogfooding: a GUI prompt referencing an existing calculator.py wrongly
    // tripped this nudge.
    if (await fileExists(clean)) continue;
    unwritten.push(clean);
  }

  if (unwritten.length === 0) return null;

  const fileList = unwritten.map((f) => `\`${f}\``).join(', ');
  return (
    `Your task mentioned ${fileList} but you finished without writing to ${unwritten.length === 1 ? 'it' : 'any of them'}. ` +
    `If the task required changes to ${unwritten.length === 1 ? 'that file' : 'those files'}, make them now. ` +
    `If you already completed everything the task asked for, ignore this and call done again.`
  );
}

// ---------------------------------------------------------------------------
// Behavioral-verification gate
//
// When the user reports a BUG (symptom language) and the agent edits code to
// fix it but never runs a test that exercises the behavior, nudge it to write
// one. Launching/compiling proves the code starts, not that the reported
// behavior is fixed — the exact gap a functional bug (e.g. "clicking the
// buttons does nothing") falls through. Deterministic gates can verify
// structure and execution, not behavior; the only way to close that is an
// actual behavioral test, which this nudges toward. Soft + bounded: the
// framing lets the model ignore it when a static check already sufficed.
// ---------------------------------------------------------------------------

/** Symptom phrasing that signals the user is reporting a behavioral bug. */
const BUG_REPORT_RE =
  /\b(does(n'?t| not) (work|run|update|populate|show|respond|display|change)|not working|nothing happens|does nothing|no longer works?|stopped working|is broken|won'?t \w+|fails? to \w+|crash(es|ing|ed)?|isn'?t \w+ing|doesn'?t do anything|broken)\b/i;

/**
 * Returns a reprompt when the current request reads as a bug report, the agent
 * edited code, but no test was run that could verify the behavioral fix.
 * `ranAnyTest` should be true when a whole-suite or single-file test executed.
 */
export function buildBehavioralVerificationReprompt(
  requestText: string,
  editedFiles: Set<string>,
  ranAnyTest: boolean,
): string | null {
  if (!requestText) return null;
  if (editedFiles.size === 0) return null; // no code changed → nothing to verify
  if (ranAnyTest) return null; // a test ran → behavioral verification happened
  if (!BUG_REPORT_RE.test(requestText)) return null;
  return (
    'You edited code to fix a reported bug but ran no test that exercises the behavior. ' +
    'Launching or compiling proves the code starts, NOT that the bug is fixed. ' +
    'Write a test that reproduces the reported behavior — call the changed function/handler directly and assert the ' +
    'result (for UI, instantiate the component and invoke its callbacks headlessly) — then run it and confirm it passes. ' +
    'If a static check (get_diagnostics) already proves the fix, ignore this and call done.'
  );
}
