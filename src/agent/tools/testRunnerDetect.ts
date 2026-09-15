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
 * The first entry is a PROJECT-SPECIFIC RUNNER SCRIPT, which outranks the
 * generic manifests because it is the command the project actually documents,
 * and its `.py` extension makes the language unambiguous. Learned from what
 * the model types unprompted: across 150 SWE-bench runs it invoked
 * `./tests/runtests.py` 160 times and never once reached for bare pytest on
 * django. Bare pytest on the django repo does not work -- its suite needs
 * runtests.py to configure settings -- so `setup.py -> pytest` there would be
 * a loud failure rather than a useful command. Runner scripts whose name does
 * NOT imply a language live in CORROBORATED_RUNNERS below.
 */
const MANIFESTS: ReadonlyArray<readonly [file: string, command: string, ecosystem: string]> = [
  ['tests/runtests.py', 'python tests/runtests.py', 'python'],
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

/**
 * Runner scripts whose NAME does not identify a language, so they are used only
 * when a manifest above has already established the ecosystem. `bin/test` is
 * sympy's runner, but it is also a Rails binstub — `python bin/test` on a Rails
 * app would be exactly the cross-language mistake this module exists to stop.
 */
const CORROBORATED_RUNNERS: ReadonlyArray<readonly [file: string, command: string, ecosystem: string]> = [
  ['bin/test', 'python bin/test', 'python'],
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
  // `manifestFiles()` must include the corroborated runners or the caller never
  // stats them and they can never win. Kept as an assertion of intent here.
  const manifestHit = MANIFESTS.find(([file]) => set.has(file));
  // A corroborated runner outranks the generic command for its ecosystem, but
  // only once that ecosystem is established by a real manifest.
  const corroborated = manifestHit
    ? CORROBORATED_RUNNERS.find(([file, , eco]) => set.has(file) && eco === manifestHit[2])
    : undefined;
  const hit = corroborated ?? manifestHit;

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
  return [...MANIFESTS.map(([file]) => file), ...CORROBORATED_RUNNERS.map(([file]) => file)];
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
