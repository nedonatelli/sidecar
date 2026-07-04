import { workspace, Uri } from 'vscode';
import * as path from 'path';
import { SOURCE_FILE_RE, TEST_FILE_RE } from './pathUtil.js';

// Behavioral-verification gate
//
// Fires when the agent edits code that has runtime BEHAVIOR but never runs a
// test exercising it — either fixing a reported bug (symptom language) or
// building something interactive/behavioral (a GUI, app, server, CLI, …).
// Launching/compiling proves the code starts, not that it behaves correctly —
// the gap a functional bug (e.g. "operator buttons don't display", "equals
// shows Error") falls straight through. Dogfooding: models "verify" a GUI by
// launching it (which only proves startup) and ship behaviorally-broken code.
// Deterministic gates verify structure + execution, not behavior; the only
// thing that closes that is an actual behavioral test, which this nudges
// toward. Soft + bounded: the framing lets the model skip it when a static
// check genuinely sufficed (e.g. a type-only fix).
// ---------------------------------------------------------------------------

/** Symptom phrasing that signals the user is reporting a behavioral bug. */
const BUG_REPORT_RE =
  /\b(does(n'?t| not) (work|run|update|populate|show|respond|display|change)|not working|nothing happens|does nothing|no longer works?|stopped working|is broken|won'?t \w+|fails? to \w+|crash(es|ing|ed)?|isn'?t \w+ing|doesn'?t do anything|broken)\b/i;

/**
 * Nouns that signal the request produces code with interactive/runtime behavior
 * worth a behavioral test (vs. structural artifacts like a config file or type
 * definition, which don't match and so don't trip the gate).
 */
const BEHAVIORAL_BUILD_RE =
  /\b(gui|app|application|calculator|game|cli|command[- ]line|server|endpoint|route|web ?app|widget|form|dialog|menu|button|window|screen|interactive|chatbot|\bbot\b|api|webhook|parser|validator|simulator|handler)\b/i;

/** Python test-file conventions (pytest/unittest discovery): test_*.py and *_test.py. */
const PY_TEST_FILE_RE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/;

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Default workspace file reader for behavioral coverage. Injectable for tests. */
async function defaultReadFile(relPath: string): Promise<string | null> {
  const root = workspace.workspaceFolders?.[0]?.uri;
  if (!root) return null;
  try {
    const bytes = await workspace.fs.readFile(Uri.joinPath(root, relPath));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

/** True if `content` references `moduleName` as a whole word (an import or symbol use). */
/**
 * True if `content` IMPORTS `moduleName` — the module name must appear on a line
 * with `import` / `from` / `require`, not merely anywhere in the file. A bare
 * word match let a hollow test "reference" the module in a comment/docstring
 * (`# uses gui_calculator`) and pass as if it tested the real code. Covers
 * Python (`from gui_calculator import …`, `import gui_calculator`), JS/TS
 * (`from './gui_calculator'`, `require('./gui_calculator')`, `import … from
 * "gui_calculator"`), and dynamic (`import_module('gui_calculator')`).
 */
function referencesModule(content: string, moduleName: string): boolean {
  const m = escapeRegExp(moduleName);
  return new RegExp(`^.*\\b(?:import|from|require)\\b.*\\b${m}\\b`, 'm').test(content);
}

/**
 * Conventional test-file paths that would exercise `editedFile`. Used when a
 * whole-suite run fired (no explicit file arg) so we can still confirm a test
 * for this module actually exists and imports it. Covers the colocated and
 * top-level `tests/` placements for Python and JS/TS conventions.
 */
function candidateTestFiles(editedFile: string): string[] {
  const ext = path.extname(editedFile);
  const base = path.basename(editedFile, ext);
  const slash = editedFile.lastIndexOf('/');
  const dir = slash === -1 ? '' : editedFile.slice(0, slash);
  const names = ext === '.py' ? [`test_${base}.py`, `${base}_test.py`] : [`${base}.test${ext}`, `${base}.spec${ext}`];
  const prefixes = dir ? [`${dir}/`, '', 'tests/', 'test/'] : ['', 'tests/', 'test/'];
  const out: string[] = [];
  for (const p of prefixes) for (const n of names) out.push(p + n);
  return [...new Set(out)];
}

/**
 * True if a test that actually exercises `file`'s module ran AND PASSED this
 * turn. Three things must hold: the test imports the edited module (target
 * coverage — `pytest test_calculator.py` does not exercise `gui_calculator.py`),
 * launching the program proves startup not behavior, and the run must have
 * PASSED — a run that collected 0 tests or failed verified nothing (it's in
 * testsRunForFiles but not passingTestFiles). Explicit passing runs are checked
 * directly; a passing whole-suite run is confirmed against the module's
 * conventional test files on disk.
 */
async function behavioralFileExercised(
  file: string,
  gateState: { passingTestFiles: Set<string>; projectTestsPassed: boolean },
  readFile: (p: string) => Promise<string | null>,
): Promise<boolean> {
  const moduleName = path.basename(file, path.extname(file));
  const testFiles = new Set<string>(gateState.passingTestFiles);
  if (gateState.projectTestsPassed) for (const c of candidateTestFiles(file)) testFiles.add(c);
  for (const t of testFiles) {
    const content = await readFile(t);
    if (content && referencesModule(content, moduleName)) return true;
  }
  return false;
}

/** True if `candidate` is (or shares a basename with) one of `file`'s conventional test files. */
function isTestFileFor(candidate: string, file: string): boolean {
  const wanted = new Set(candidateTestFiles(file).map((c) => c.split('/').pop()!));
  return wanted.has(candidate.split('/').pop()!);
}

/**
 * Detect a HOLLOW test for `file`: a conventionally-named test file the model
 * wrote or ran that never imports/references the module under test (so it
 * exercises a mock/stub, not the real code). Dogfooding: the model "satisfied"
 * the behavioral gate with `test_gui_calculator.py` that defined an inline
 * MockCalculatorApp and never imported `gui_calculator` — the real `7+3 → 73`
 * bug sailed through. Returns the hollow test's path, or null if none.
 */
async function findHollowTest(
  file: string,
  editedFiles: Set<string>,
  gateState: { testsRunForFiles: Set<string> },
  readFile: (p: string) => Promise<string | null>,
): Promise<string | null> {
  const moduleName = path.basename(file, path.extname(file));
  const present = new Set<string>();
  for (const f of [...editedFiles, ...gateState.testsRunForFiles]) {
    if (isTestFileFor(f, file)) present.add(f);
  }
  for (const t of present) {
    const content = await readFile(t);
    if (content !== null && content !== '' && !referencesModule(content, moduleName)) return t;
  }
  return null;
}

/**
 * Returns a reprompt when the current request involves runtime behavior (a bug
 * fix OR a build of something interactive/behavioral), the agent edited code,
 * but no test actually EXERCISED the edited code. Target-aware: running an
 * unrelated test suite (e.g. `pytest test_calculator.py` after editing
 * `gui_calculator.py`) or merely launching/constructing the program does not
 * satisfy the gate — only a test file that imports the edited module does.
 */
export async function buildBehavioralVerificationReprompt(
  requestText: string,
  editedFiles: Set<string>,
  gateState: { testsRunForFiles: Set<string>; passingTestFiles: Set<string>; projectTestsPassed: boolean },
  readFile: (p: string) => Promise<string | null> = defaultReadFile,
  failureContext?: string,
): Promise<string | null> {
  if (!requestText) return null;
  if (editedFiles.size === 0) return null; // no code changed → nothing to verify
  const isBug = BUG_REPORT_RE.test(requestText);
  const isBehavioralBuild = BEHAVIORAL_BUILD_RE.test(requestText);
  if (!isBug && !isBehavioralBuild) return null; // structural/non-behavioral work — skip

  // Only behavioral SOURCE edits obligate a behavioral test — test files and
  // type-only declarations don't test themselves.
  const behavioralEdits = [...editedFiles].filter(
    (f) => SOURCE_FILE_RE.test(f) && !f.endsWith('.d.ts') && !TEST_FILE_RE.test(f) && !PY_TEST_FILE_RE.test(f),
  );
  if (behavioralEdits.length === 0) return null;

  const uncovered: string[] = [];
  const hollow: { file: string; testFile: string }[] = [];
  for (const file of behavioralEdits) {
    if (await behavioralFileExercised(file, gateState, readFile)) continue;
    const hollowTest = await findHollowTest(file, editedFiles, gateState, readFile);
    if (hollowTest) hollow.push({ file, testFile: hollowTest });
    else uncovered.push(file);
  }
  if (uncovered.length === 0 && hollow.length === 0) return null; // every edited behavioral file is genuinely tested

  const what = isBug ? 'to fix a reported bug' : 'that has runtime behavior';
  const parts: string[] = [];

  if (hollow.length > 0) {
    const list = hollow.map((h) => `\`${h.testFile}\` (meant to test \`${h.file}\`)`).join(', ');
    const importHint = hollow.map((h) => `from ${path.basename(h.file, path.extname(h.file))} import …`).join(' / ');
    parts.push(
      `Your test does not test the real code: ${list} never imports the module under test — it defines its own ` +
        `mock/stub and asserts against that, so the actual behavior is unverified. A bug like "7+3 shows 73" only ` +
        `surfaces when the test drives the ACTUAL code. Rewrite it to import the real module (\`${importHint}\`), ` +
        `construct/call it, invoke its functions or callbacks, and assert the real result — then run it and read the output.`,
    );
  }

  if (uncovered.length > 0) {
    const fileList = uncovered.map((f) => `\`${f}\``).join(', ');
    const failure = failureContext
      ? `\n\nYour most recent test/diagnostic output (a run that collects 0 tests or fails verifies NOTHING — fix what this shows):\n\`\`\`\n${failureContext}\n\`\`\``
      : '';
    parts.push(
      `You edited code ${what} (${fileList}) but no test that PASSES exercises ${uncovered.length === 1 ? 'it' : 'them'}. ` +
        'Launching or compiling proves the code starts, NOT that it works (a GUI can open with dead buttons; ' +
        'a script can import cleanly and still compute the wrong answer). A test that ran but FAILED, or that collected ' +
        '0 tests ("no tests ran"), or an UNRELATED suite, does NOT count. ' +
        'Write a test that imports the changed module and calls the changed function/handler directly, asserting the result ' +
        '(for UI, construct the component and invoke its callbacks headlessly, asserting the resulting display/state), then ' +
        `run it and confirm it actually passes.${failure}`,
    );
  }

  return parts.join('\n\n');
}
