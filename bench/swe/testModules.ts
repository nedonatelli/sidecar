// ---------------------------------------------------------------------------
// Test-module labels for the task prompt.
//
// A test label is not derivable from the source path. Nothing connects
// `django/core/files/uploadedfile.py` to the module that covers it,
// `file_uploads` — the mapping lives in django's `tests/` directory layout and
// nowhere else.
//
// Measured 2026-08-18 on gemma4:e4b, after the prompt already demanded a dotted
// label: every invocation targeted a SOURCE module — `django.core.files
// .uploadedfile`, `django.contrib.auth.validators` — and django answered
// `Ran 0 tests ... OK` seven times in a row. Not an error, and it reads like
// success, so the agent had no way to notice its verification was hollow.
//
// The model was guessing because guessing was all it could do. This hands it the
// actual list, which is plain repo structure any `ls` would reveal — NOT
// gold-answer information. `FAIL_TO_PASS` stays hidden; the agent still has to
// choose the right module from ~200 candidates.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

/**
 * Directory names under `<repoDir>/tests/`, which is what the repo's runner
 * accepts as a test label. Sorted so the prompt is byte-stable across runs
 * (an unstable prompt prefix would defeat prompt caching for every task).
 *
 * Returns `[]` when there is no `tests/` directory — repos that lay their tests
 * out differently get no hint rather than a wrong one.
 */
export function listTestModules(repoDir: string): string[] {
  const testsDir = path.join(repoDir, 'tests');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(testsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== '__pycache__' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** The prompt fragment naming valid labels. Empty string when none are found. */
export function renderTestModuleHint(repoDir: string): string {
  const modules = listTestModules(repoDir);
  if (modules.length === 0) return '';
  return (
    `The runner's valid test labels are these ${modules.length} modules from the repository's test ` +
    `directory. They are NOT source module paths — \`django.core.files.uploadedfile\` is a source ` +
    `path and runs zero tests. Choose the one covering the code you changed:\n${modules.join(', ')}`
  );
}

/**
 * How a task's test runner selects tests. Django's runtests.py takes dotted
 * module labels; pytest -- and tox, which passes its arguments to pytest -- and
 * sympy's bin/test take test FILE paths. The task prompt used to give every
 * runner the Django instructions ("dotted label, no .py, no paths"), and on
 * path-based runners that selects nothing: about 160 test executions in four
 * canary cells ran zero tests, and sphinx was pointed at `tox -- roots`, a
 * fixtures directory (#213).
 */
export type RunnerFamily = 'django' | 'pytest' | 'tox' | 'sympy' | 'other';

export function runnerFamily(testCmd: string): RunnerFamily {
  if (/runtests\.py/.test(testCmd)) return 'django';
  if (/(^|\s)bin\/test\b/.test(testCmd)) return 'sympy';
  if (/(^|\s)tox\b/.test(testCmd)) return 'tox';
  if (/(^|\s)pytest\b/.test(testCmd)) return 'pytest';
  return 'other';
}

/** A real test file from the repo to show as the example, or a generic one. */
function exampleTestFile(repoDir: string, family: RunnerFamily): string {
  const candidates =
    family === 'sympy'
      ? ['sympy/core/tests/test_basic.py']
      : ['testing/test_skipping.py', 'tests/test_ext_autodoc.py', 'test_requests.py', 'tests/test_api.py'];
  for (const c of candidates) if (fs.existsSync(path.join(repoDir, c))) return c;
  return family === 'sympy' ? 'sympy/<area>/tests/test_<module>.py' : 'tests/test_<module>.py';
}

/**
 * The task prompt's test-scoping instructions for a path-based runner, or null
 * for Django (whose dotted-label instructions stay as they are) and unknown
 * runners (#213). The default since 2026-10-30; SIDECAR_SWE_TEST_TARGETS=legacy turns it off.
 */
export function renderPathRunnerInstructions(runner: string, family: RunnerFamily, repoDir: string): string | null {
  if (family === 'django' || family === 'other') return null;
  const example = exampleTestFile(repoDir, family);
  const node = family === 'sympy' ? '' : `, optionally narrowed to one test with \`::TestClass::test_name\``;
  const dotted = `\`${example.replace(/\.py$/, '').replace(/\//g, '.')}\``;
  // sympy's bin/test matches a bare name as a keyword (`test_basic` runs it);
  // pytest treats one as a missing file. Verified in each repo's venv (#213).
  const wrong =
    family === 'sympy'
      ? `A dotted module name (${dotted})`
      : `A dotted module name (${dotted}) or a bare name (\`${path.basename(example, '.py')}\`)`;
  return (
    `You MUST scope every test run to the test FILE covering this issue by appending its path:\n` +
    `  ${runner} ${example}\n` +
    `The target is a filesystem path to a test file, relative to the repository root${node}. ` +
    `${wrong} selects NO tests: "no tests ran", "collected 0 items", ` +
    `"file or directory not found" or "0 passed" means your target was wrong, not that your change works.\n` +
    `Find the test file for the code you changed with run_command, e.g. ` +
    `\`find . -name "test_*.py" | grep <keyword>\`.\n` +
    `Do NOT run \`${runner}\` with no target — that executes the project's entire suite. It takes many ` +
    `minutes and its output is truncated before the part you need.\n\n` +
    `Reproduce the issue with a failing test, make the code change that fixes it, then re-run the ` +
    `scoped tests to verify before you finish.`
  );
}
