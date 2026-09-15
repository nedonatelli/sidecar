// Which test runner does this project use? Pure decision, so it can be tested
// against a real repo's file set instead of only through the filesystem.
//
// THE BUG THIS FIXES. Detection asked `package.json` first and, if it had a
// `scripts.test`, returned `npm test` unconditionally -- before pytest, Cargo,
// Go or Gradle were considered. Django ships a package.json whose test script
// is `eslint django/ js_tests/...`, so on 2026-08-18 `run_tests` LINTED
// JAVASCRIPT on a Django task and reported `ok`. A verification tool that
// returns success while verifying nothing is worse than one that errors: the
// whole-suite guard could not catch it either, because run_tests was called
// with no `command`, so there was nothing to inspect. run_tests was removed
// from the SWE eval catalog (ebb6d02) to work around it; the detection itself
// was never fixed, and sympy, matplotlib, scikit-learn and pandas all ship a
// package.json too, so any user on a polyglot Python repo could hit it.
//
// THE RULE. A package.json is weak evidence of the project's primary language
// -- Python repos routinely carry one for frontend assets -- while a Python,
// Rust, Go or Gradle manifest is strong evidence. So npm wins only when no
// other ecosystem's manifest is present. When markers genuinely conflict the
// result says so, because the failure directions are not symmetric: running
// pytest in a JS repo fails loudly and costs one turn, while running a JS
// linter in a Python repo reports success and silently invalidates the run.

/**
 * Manifest files that identify an ecosystem, strongest signal first.
 *
 * The first entries are PROJECT-SPECIFIC RUNNER SCRIPTS, which outrank generic
 * manifests because they are the command the project actually documents. Both
 * were learned from what the model types unprompted on these repos: across 150
 * SWE-bench runs it invoked `./tests/runtests.py` 160 times and sympy's
 * `bin/test` 57 times, and never once reached for bare pytest on them. Bare
 * pytest on the Django repo does not work -- its suite needs runtests.py to
 * configure settings -- so detecting `setup.py -> pytest` there would be a
 * loud failure rather than a useful command.
 */
const MANIFESTS: ReadonlyArray<readonly [file: string, command: string, ecosystem: string]> = [
  ['tests/runtests.py', 'python tests/runtests.py', 'python'],
  ['bin/test', 'python bin/test', 'python'],
  ['pytest.ini', 'pytest', 'python'],
  ['manage.py', 'python -m pytest', 'python'],
  ['setup.py', 'pytest', 'python'],
  ['pyproject.toml', 'pytest', 'python'],
  ['setup.cfg', 'pytest', 'python'],
  ['tox.ini', 'pytest', 'python'],
  ['Cargo.toml', 'cargo test', 'rust'],
  ['go.mod', 'go test ./...', 'go'],
  ['build.gradle', './gradlew test', 'jvm'],
  ['build.gradle.kts', './gradlew test', 'jvm'],
];

export interface RunnerDecision {
  /** The command to run, or null when nothing identifies a runner. */
  command: string | null;
  /** Which ecosystem's marker decided it. */
  ecosystem: string | null;
  /** The marker that decided it, for the tool result and the trajectory. */
  reason: string;
  /**
   * True when a package.json test script was present but LOST to a stronger
   * manifest. Surfaced so the caller can say which runner it picked and why —
   * the silent wrong pick is the whole defect.
   */
  ambiguous: boolean;
}

/**
 * Decide the runner from the set of manifest files present at the project root.
 *
 * @param present         root-relative filenames that exist (e.g. ['setup.py'])
 * @param hasNpmTestScript whether package.json exists AND declares scripts.test
 */
export function detectTestRunner(present: readonly string[], hasNpmTestScript: boolean): RunnerDecision {
  const set = new Set(present.map((f) => f.trim()).filter(Boolean));
  const hit = MANIFESTS.find(([file]) => set.has(file));

  if (hit) {
    const [file, command, ecosystem] = hit;
    return {
      command,
      ecosystem,
      reason: hasNpmTestScript
        ? `${file} (a package.json test script is also present; ${ecosystem} wins because a package.json is often only frontend tooling — pass an explicit command to override)`
        : file,
      ambiguous: hasNpmTestScript,
    };
  }

  if (hasNpmTestScript) {
    return { command: 'npm test', ecosystem: 'node', reason: 'package.json scripts.test', ambiguous: false };
  }

  return { command: null, ecosystem: null, reason: 'no test manifest found', ambiguous: false };
}

/** The manifest filenames the caller needs to stat, in priority order. */
export function manifestFiles(): string[] {
  return MANIFESTS.map(([file]) => file);
}

/**
 * Convert a test target into the form the detected runner accepts.
 *
 * Django's `runtests.py` takes a DOTTED LABEL relative to `tests/`, not a path.
 * Observed 2026-08-18: the model scoped correctly in spirit but passed
 * `tests/file_uploads/`; django derived `file_uploads.tests`, which failed to
 * import, and it retried the same thing four times for zero tests run. The
 * prompt was tightened and the model still produced paths, so the conversion
 * belongs at the tool boundary where it is deterministic — the same principle
 * that removed run_tests from the eval catalog rather than asking the model to
 * avoid it.
 *
 * Only runtests.py is transformed. pytest genuinely wants paths, and sympy's
 * `bin/test` accepts either, so both are passed through untouched.
 */
export function normalizeTestTarget(command: string, target: string): string {
  const t = target.trim();
  if (!t || !/runtests\.py\b/.test(command)) return t;
  // Already a dotted label (no separators) — nothing to do.
  if (!/[\\/]/.test(t)) return t;
  const cleaned = t
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^tests\//, '')
    .replace(/\/+$/, '')
    .replace(/\.py$/, '');
  return cleaned.split('/').filter(Boolean).join('.');
}
