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
