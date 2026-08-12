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
  const binDir = path.join(venvDir, 'bin');
  const pythonBin = path.join(binDir, 'python');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VIRTUAL_ENV: venvDir,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  if (!fs.existsSync(marker)) {
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
    fs.writeFileSync(marker, `${repo}@${version} python=${pythonForUv(spec.python)}\n`);
  }

  // The editable install must be re-ensured every task: the harness's
  // `git clean -fdx` between tasks wipes the repo's *.egg-info, which would
  // otherwise leave the (marker-cached) venv unable to import the repo. uv makes
  // this a fast no-op when already satisfied.
  execFileSync(uv, ['pip', 'install', '--python', pythonBin, '-e', '.'], { cwd: repoDir, stdio: 'pipe' });

  return { venvDir, pythonBin, env, testCmd: spec.test_cmd };
}
