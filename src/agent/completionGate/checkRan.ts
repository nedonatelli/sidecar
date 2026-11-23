/**
 * Whether a check's result shows the check actually ran (#471, #473).
 *
 * The completion gate credits a test or lint run from the command it sees, and
 * then reads the output for pass or fail. Several results come back from
 * commands that never ran a check. Each used to satisfy a gate demand
 * (`needsTestRun`, `missingTest`, `needsLint`) and arm the keep-best ratchet's
 * `verificationAttempted`; a collection crash also armed the red-check gate,
 * which told the model to fix a failing test the environment had caused.
 *
 * One predicate, read by every path that credits a check: run_tests, each
 * run_command branch, and the action reprompt's clean-verify check.
 */

export type CheckDidNotRun =
  /** run_command with `background: true`: started, nothing has finished. */
  | 'background'
  /** The context's command filter refused it. */
  | 'rejected'
  /** run_tests found no test runner and returned guidance. */
  | 'no-runner'
  /** ESLint aimed at Python files was redirected without running. */
  | 'redirected'
  /** The shell killed it before it finished. */
  | 'timed-out'
  /** The runner started, but crashed loading the tests and ran none (#471). */
  | 'collection-error';

const exitCodeOf = (text: string): number | undefined => {
  const m = /exit code:\s*(-?\d+)/i.exec(text);
  return m ? parseInt(m[1], 10) : undefined;
};

/**
 * pytest stops while loading a conftest or importing a test module and exits 2
 * (interrupted) or 4 (usage error, which includes a conftest that fails to
 * import); 3 is an internal error. Exit 2 alone also means a user interrupt,
 * so the wording has to say collection. unittest reports a module it can't
 * import as a failed test, so its wording alone is enough.
 */
const PYTEST_COLLECTION_RE =
  /ImportError while loading conftest|^_+ ERROR collecting |^ERROR collecting |Interrupted: \d+ errors? during collection|ERROR: file or directory not found/m;
const UNITTEST_IMPORT_RE = /ImportError: Failed to import test module/;

export function isCollectionError(text: string): boolean {
  if (UNITTEST_IMPORT_RE.test(text)) return true;
  const exit = exitCodeOf(text);
  return exit !== undefined && exit >= 2 && exit <= 4 && PYTEST_COLLECTION_RE.test(text);
}

/** Why `resultText` shows its check never ran, or null when it ran. */
export function checkDidNotRun(resultText: string): CheckDidNotRun | null {
  if (/Background command started with ID: /.test(resultText)) return 'background';
  if (/Command rejected: [\s\S]*? is not in the allowed list for this context/.test(resultText)) return 'rejected';
  if (/Could not detect test runner/.test(resultText)) return 'no-runner';
  if (/ESLint only lints JavaScript\/TypeScript — it cannot check Python files/.test(resultText)) return 'redirected';
  if (/⚠️ Command timed out after /.test(resultText)) return 'timed-out';
  if (isCollectionError(resultText)) return 'collection-error';
  return null;
}

/**
 * The line that names why collection failed, bounded, for the gate's note:
 * pytest's last `E` line that names an exception (an import error's own
 * advice text follows it: scikit-learn's ends "Python version, your operating
 * system and your platform."), else its last `E` line; unittest's ImportError;
 * or the collection line itself (`ERROR: file or directory not found: …`).
 */
export function collectionErrorLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const eLines = lines.filter((l) => /^E\s{2,}\S/.test(l)).map((l) => l.replace(/^E\s+/, ''));
  const pick =
    eLines.filter((l) => /^[\w.]*(Error|Exception)\b/.test(l)).at(-1) ??
    eLines.at(-1) ??
    lines.find((l) => /ImportError|ModuleNotFoundError/.test(l))?.trim() ??
    lines.find((l) => PYTEST_COLLECTION_RE.test(l))?.trim() ??
    'the test runner failed while collecting the tests';
  return pick.slice(0, 200);
}

/** Whether a collection error is a test path the runner couldn't find: the model's target, not the environment. */
export function isMissingTestPath(errorLine: string): boolean {
  return /file or directory not found/i.test(errorLine);
}
