// ---------------------------------------------------------------------------
// Per-task solve ENVIRONMENT for SWE-bench.
//
// The agent can only reproduce/verify a fix if the repo's dependencies are
// actually installed. This builds a uv venv per (repo, version) — spec-driven
// from bench/swe/data/env-specs.json (generated from swebench's authoritative
// MAP_REPO_VERSION_TO_SPECS) — and returns the VIRTUAL_ENV/PATH to hand the
// agent's shell session, plus the real test command. Cached across tasks/runs.
//
// Pure-Python repos (django, sympy, sphinx, pytest, pylint, requests) install
// cleanly and offline. Native-dep repos (numpy/scipy/matplotlib/scikit-learn/…)
// return null here — they need the containerized fallback (Phase 2). See
// bench/swe/ENVIRONMENT-SCOPING.md.
// ---------------------------------------------------------------------------
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface EnvSpec {
  python: string;
  pre_install?: string[] | string;
  pip_packages?: string[] | string;
  install?: string;
  test_cmd?: string;
}
export type SpecMap = Record<string, Record<string, EnvSpec>>;

export interface TaskEnv {
  venvDir: string;
  pythonBin: string;
  /** Environment for the shell session: process.env + venv VIRTUAL_ENV/PATH. */
  env: Record<string, string>;
  /** The repo's real test command (from the spec), for the agent's guidance. */
  testCmd?: string;
}

// Repos whose pinned deps build native C extensions at old versions — no arm64
// wheels, won't compile against modern clang. Routed to the container fallback.
const NATIVE_DEP_REPOS = new Set([
  'matplotlib/matplotlib',
  'scikit-learn/scikit-learn',
  'astropy/astropy',
  'mwaskom/seaborn',
  'pydata/xarray',
  'numpy/numpy',
  'scipy/scipy',
  'pandas-dev/pandas',
]);

function resolveUv(): string {
  const candidates = [
    process.env.SIDECAR_SWE_UV,
    path.join(os.homedir(), '.local/bin/uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
    'uv',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error('uv not found — install: curl -LsSf https://astral.sh/uv/install.sh | sh');
}

/** uv's standalone-CPython floor is ~3.8; substitute older pins (validated by
 *  the gold-patch gate, which fails the task if the substituted env is wrong). */
export function pythonForUv(pinned: string): string {
  const [maj, min] = pinned.split('.').map(Number);
  return maj === 3 && min < 8 ? '3.8' : pinned;
}

function asList(v: string[] | string | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export function loadEnvSpecs(specPath: string): SpecMap {
  return JSON.parse(fs.readFileSync(specPath, 'utf-8')) as SpecMap;
}

/**
 * The editable-install target, keeping the extras the spec's `install` asks for:
 * `python -m pip install -e .[test]` -> `.[test]`. Installing a bare `.` dropped
 * sphinx's `[test]` extra, which is where its pytest comes from (#216).
 */
export function editableTarget(install: string | undefined): string {
  const extras = install?.match(/(?:^|\s)(?:-e\s+)?\.(\[[^\]\s]+\])/);
  return extras ? `.${extras[1]}` : '.';
}

/**
 * Test-requirements files SWE-bench installs for a repo's environment and that
 * the spec's `pip_packages` does not carry (its MAP_REPO_TO_REQS_PATHS). pylint
 * pins astroid and pytest there; without them the agent's tests run against the
 * wrong astroid, or the system pytest (#216). The full file, not `_min`: its
 * pytest-xdist 2.x brings `py`, whose `py.io` pytest-benchmark 3.4 needs now
 * that `pytest~=7.1` resolves to a 7.4 that no longer ships it.
 */
const TEST_REQUIREMENTS: Record<string, string> = {
  'pylint-dev/pylint': 'requirements_test.txt',
};

/**
 * Pins SWE-bench's images never needed because they resolved in 2024. Resolved
 * today, sphinx 3.4 gets setuptools 82 (no `pkg_resources`, which sphinx
 * imports at startup) and docutils 0.23 (no `docutils.utils.roman`, which its
 * LaTeX builder imports), and no test runs. Measured on sphinx-8474 (#216).
 */
const ERA_CONSTRAINTS: Record<string, string[]> = {
  'sphinx-doc/sphinx': ['setuptools<81', 'docutils<0.22'],
};

/**
 * The version pins a spec's `pre_install` writes into setup.py, as pip
 * constraints: `sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py` -> `Jinja2<3.0`.
 * SWE-bench edits setup.py in its image; doing that here would put the edit in
 * the agent's checkout and its captured diff, so the pins go to uv instead.
 */
export function setupPyPins(preInstall: string[] | string | undefined): string[] {
  const pins: string[] = [];
  for (const cmd of asList(preInstall)) {
    const m = cmd.match(/^sed -i (["'])s\/[^/]*\/([^/]*)\/\1 setup\.py$/);
    if (!m) continue;
    const quoted = [...m[2].matchAll(/'([^']+)'/g)].map((q) => q[1]);
    for (const req of quoted.length ? quoted : [m[2]]) if (/[<>=]/.test(req)) pins.push(req);
  }
  return pins;
}

export function envConstraints(repo: string, spec: EnvSpec): string[] {
  return [...setupPyPins(spec.pre_install), ...(ERA_CONSTRAINTS[repo] ?? [])];
}

/**
 * Bump when the build recipe changes in a way cached venvs must pick up. The
 * marker records it with the spec, and a mismatch rebuilds the venv.
 */
const ENV_RECIPE_VERSION = 2;

export function envRecipeHash(repo: string, spec: EnvSpec): string {
  const recipe = JSON.stringify({
    v: ENV_RECIPE_VERSION,
    repo,
    spec,
    reqs: TEST_REQUIREMENTS[repo] ?? null,
    era: ERA_CONSTRAINTS[repo] ?? null,
  });
  return createHash('sha256').update(recipe).digest('hex').slice(0, 16);
}

/**
 * Does the test command run pytest -- directly, or through tox, which passes
 * its arguments on to pytest? Django's runtests.py and sympy's bin/test don't.
 */
export function usesPytest(testCmd: string | undefined): boolean {
  return !!testCmd && !/runtests\.py|(^|\s)bin\/test\b/.test(testCmd) && /(^|\s)(pytest|tox)\b/.test(testCmd);
}

/** Does the venv have pytest installed (a `pytest-<ver>.dist-info`, not a plugin's)? */
export function venvHasPytest(venvDir: string): boolean {
  return sitePackagesDirs(venvDir).some((site) =>
    fs.readdirSync(site).some((e) => /^pytest-[^-]+\.dist-info$/i.test(e)),
  );
}

/**
 * Where long-lived SWE caches (the per-repo venvs) live by default: the user's
 * cache directory, never os.tmpdir(). macOS purges /var/folders/<..>/T daily,
 * file by file, deleting anything whose access AND modification times are both
 * over ~3 days old -- and uv installs a wheel's files with the wheel's own
 * mtimes, so a fresh venv is full of "old" files. Packages the agent imported
 * survived; their never-read METADATA/RECORD did not, and every later task in
 * that repo failed at 0 turns until someone deleted the venv by hand (#208).
 * Windows can clean %TEMP% too (Storage Sense).
 */
export function defaultSweCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'sidecar-swe');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'sidecar-swe');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'sidecar-swe');
}

/** Every site-packages directory of a venv (lib/python3.x/site-packages, or Lib/site-packages on Windows). */
function sitePackagesDirs(venvDir: string): string[] {
  const dirs = [path.join(venvDir, 'Lib', 'site-packages')];
  const lib = path.join(venvDir, 'lib');
  if (fs.existsSync(lib)) {
    for (const d of fs.readdirSync(lib)) dirs.push(path.join(lib, d, 'site-packages'));
  }
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

/**
 * Is a cached venv still whole? A venv half-deleted by a temp-dir purge keeps
 * its `.sidecar-ready` marker and the modules something imported, but loses the
 * `*.dist-info/METADATA` nothing reads during a run -- and uv then refuses
 * every install into it ("Failed to read metadata from installed package").
 */
export function venvLooksIntact(venvDir: string, pythonBin: string): boolean {
  if (!fs.existsSync(pythonBin)) return false;
  for (const site of sitePackagesDirs(venvDir)) {
    for (const entry of fs.readdirSync(site)) {
      if (entry.endsWith('.dist-info') && !fs.existsSync(path.join(site, entry, 'METADATA'))) return false;
    }
  }
  return true;
}

/**
 * Give a Windows venv a `python3` that is the venv's own interpreter.
 *
 * A Windows venv's Scripts\ has python.exe but no python3.exe, so under the
 * agent's Git Bash shell `python3` fell through PATH to the system Python (the
 * Windows Store alias here). gemma4:31b types `python3` often, so its
 * reproduction scripts and test runs used the wrong interpreter -- outside the
 * task's dependencies -- while `python` worked; sympy-12419's "compatibility"
 * edits to unrelated files were the model working around exactly that. Linux
 * and macOS venvs already ship python3.
 *
 * uv's python.exe is a launcher that reads the venv's pyvenv.cfg, so a copy
 * under another name runs inside the venv (checked: sys.prefix is the venv).
 * Runs on every task, not only at build, so venvs cached before this change
 * get it too; it's a no-op once the copy exists.
 */
export function ensurePython3Alias(binDir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return;
  const python = path.join(binDir, 'python.exe');
  const python3 = path.join(binDir, 'python3.exe');
  if (fs.existsSync(python) && !fs.existsSync(python3)) fs.copyFileSync(python, python3);
}

/**
 * Build (or reuse) the solve environment for a task. Returns null when no local
 * environment is available (native-dep repo, or no spec) — the caller runs
 * without one (blind, Phase-2 territory).
 */
export function setupTaskEnv(
  repo: string,
  version: string,
  repoDir: string,
  cacheBase: string,
  specs: SpecMap,
): TaskEnv | null {
  if (NATIVE_DEP_REPOS.has(repo)) return null;
  const spec = specs[repo]?.[version];
  if (!spec) return null;

  const uv = resolveUv();
  const key = `${repo.replace(/[/\\]/g, '_')}@${version}`;
  // Absolute — the venv python is passed to `uv pip install --python` with
  // cwd=repoDir, so a relative path would resolve against the repo and fail.
  const venvDir = path.resolve(cacheBase, 'venvs', key);
  const marker = path.join(venvDir, '.sidecar-ready');
  const recipe = envRecipeHash(repo, spec);
  // Windows venvs put the interpreter in Scripts\python.exe, not bin/python.
  // Hardcoding the POSIX layout made `uv pip install --python .../bin/python`
  // fail with "No virtual environment or system Python installation found" for
  // every repo that builds a venv — django, sympy, pytest, sphinx, requests and
  // pylint, 78 of 100 task-arms. The repos that appeared to work were the ones
  // in NATIVE_DEP_REPOS, which return null above and never build one.
  const isWindows = process.platform === 'win32';
  const binDir = path.join(venvDir, isWindows ? 'Scripts' : 'bin');
  const pythonBin = path.join(binDir, isWindows ? 'python.exe' : 'python');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VIRTUAL_ENV: venvDir,
    // path.delimiter, not ':' — PATH is ';'-separated on Windows, so a POSIX
    // join silently produced one unusable entry instead of two.
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  const build = (): void => {
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    fs.rmSync(venvDir, { recursive: true, force: true });
    execFileSync(uv, ['venv', '--python', pythonForUv(spec.python), venvDir], { stdio: 'pipe' });
    // Extra pip packages the spec pins (best-effort; a failing optional dep
    // shouldn't sink the whole env — the gold-patch gate catches a broken one).
    const pips = asList(spec.pip_packages);
    if (pips.length) {
      try {
        execFileSync(uv, ['pip', 'install', '--python', pythonBin, ...pips], { cwd: repoDir, stdio: 'pipe' });
      } catch {
        /* optional deps — continue; validation gate is the real check */
      }
    }
    fs.writeFileSync(marker, `${repo}@${version} python=${pythonForUv(spec.python)} recipe=${recipe}\n`);
  };

  // A venv built by an older recipe (or for a different spec) is rebuilt, so a
  // fix to the recipe reaches every cached venv instead of only new ones.
  const markerCurrent = (): boolean => {
    try {
      return fs.readFileSync(marker, 'utf-8').includes(`recipe=${recipe}`);
    } catch {
      return false;
    }
  };

  let fresh = false;
  if (!markerCurrent() || !venvLooksIntact(venvDir, pythonBin)) {
    build();
    fresh = true;
  }

  // The editable install must be re-ensured every task: the harness's
  // `git clean -fdx` between tasks wipes the repo's *.egg-info, which would
  // otherwise leave the (marker-cached) venv unable to import the repo. uv makes
  // this a fast no-op when already satisfied.
  // Every install from here on resolves under the spec's setup.py pins and the
  // era pins. Not pip_packages above: sphinx's spec installs Jinja2==3.0.3 and
  // then pins Jinja2<3.0 in setup.py, and SWE-bench's order lets the second win.
  const constraints = envConstraints(repo, spec);
  const install = (args: string[]): void => {
    const extra: string[] = [];
    if (constraints.length) {
      const file = path.join(venvDir, '.sidecar-constraints.txt');
      fs.writeFileSync(file, constraints.join('\n') + '\n');
      extra.push('-c', file);
    }
    execFileSync(uv, ['pip', 'install', '--python', pythonBin, ...args, ...extra], { cwd: repoDir, stdio: 'pipe' });
  };
  const installRepo = (): void => install(['-e', editableTarget(spec.install)]);
  try {
    installRepo();
  } catch (err) {
    // A reused venv can be damaged in ways the integrity check misses; rebuild
    // it once rather than fail every remaining task in this repo/version.
    if (fresh) throw err;
    build();
    installRepo();
  }

  // A pytest/tox runner needs pytest IN the venv. With none there, the agent's
  // `pytest` fell through PATH to whatever the machine had -- here a system
  // Python 3.14 pytest that couldn't import the repo's dependencies -- for
  // requests, pylint and sphinx in every baseline (#216). Needs the repo
  // checked out, so it runs after the editable install, not in build();
  // uv makes it a fast no-op once satisfied.
  if (usesPytest(spec.test_cmd)) {
    const reqs = TEST_REQUIREMENTS[repo];
    if (reqs && fs.existsSync(path.join(repoDir, reqs))) {
      try {
        install(['-r', reqs]);
      } catch {
        /* best-effort, like pip_packages; the pytest fallback below still runs */
      }
    }
    // Unpinned, as SWE-bench's own requests environment is: uv resolves the
    // newest pytest that supports the venv's Python.
    if (!venvHasPytest(venvDir)) {
      install(['pytest']);
    }
  }

  ensurePython3Alias(binDir);

  return { venvDir, pythonBin, env, testCmd: spec.test_cmd };
}
