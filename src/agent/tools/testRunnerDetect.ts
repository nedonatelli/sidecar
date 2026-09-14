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

/** Manifest files that identify an ecosystem, strongest signal first. */
const MANIFESTS: ReadonlyArray<readonly [file: string, command: string, ecosystem: string]> = [
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
