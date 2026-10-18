import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// #208: macOS purged a cached venv file by file; its marker survived, so the
// harness reused it and `uv pip install -e .` failed every Django task at 0
// turns, labeled [capability]. uv is faked here: `venv` lays out a real venv
// directory on disk, so the integrity check and the rebuild path run for real.
const uvCalls: string[][] = [];
let failEditableInstalls = 0;

vi.mock('node:child_process', () => ({
  execFileSync: (_cmd: string, args: string[]) => {
    uvCalls.push(args);
    if (args[0] === 'venv') {
      const venvDir = args[args.length - 1];
      const win = process.platform === 'win32';
      const bin = path.join(venvDir, win ? 'Scripts' : 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, win ? 'python.exe' : 'python'), '');
      const site = win
        ? path.join(venvDir, 'Lib', 'site-packages')
        : path.join(venvDir, 'lib', 'python3.9', 'site-packages');
      fs.mkdirSync(path.join(site, 'sqlparse-0.5.5.dist-info'), { recursive: true });
      fs.writeFileSync(path.join(site, 'sqlparse-0.5.5.dist-info', 'METADATA'), 'Name: sqlparse\n');
    }
    if (args[0] === 'pip' && args.includes('pytest')) {
      const venvDir = path.dirname(path.dirname(args[args.indexOf('--python') + 1]));
      const site =
        process.platform === 'win32'
          ? path.join(venvDir, 'Lib', 'site-packages')
          : path.join(venvDir, 'lib', 'python3.9', 'site-packages');
      fs.mkdirSync(path.join(site, 'pytest-8.3.5.dist-info'), { recursive: true });
      fs.writeFileSync(path.join(site, 'pytest-8.3.5.dist-info', 'METADATA'), 'Name: pytest\n');
    }
    if (args[0] === 'pip' && args.includes('-e') && failEditableInstalls > 0) {
      failEditableInstalls--;
      throw new Error('Command failed: uv pip install --python x -e .\n  × Failed to read `sqlparse==0.5.5`');
    }
    return Buffer.from('');
  },
}));

import { setupTaskEnv, venvLooksIntact, venvHasPytest, defaultSweCacheDir, type SpecMap } from './taskEnv.js';
import { classifyFailure } from './failureClassification.js';

const SPECS: SpecMap = { 'django/django': { '3.0': { python: '3.9' } } };
let cache: string;
let repo: string;
const venvBuilds = () => uvCalls.filter((a) => a[0] === 'venv').length;
const metadata = (venvDir: string) =>
  process.platform === 'win32'
    ? path.join(venvDir, 'Lib', 'site-packages', 'sqlparse-0.5.5.dist-info', 'METADATA')
    : path.join(venvDir, 'lib', 'python3.9', 'site-packages', 'sqlparse-0.5.5.dist-info', 'METADATA');

beforeEach(() => {
  uvCalls.length = 0;
  failEditableInstalls = 0;
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-cache-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-repo-'));
});

afterEach(() => {
  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('cached task venvs (#208)', () => {
  it('reuses an intact cached venv without rebuilding it', () => {
    const first = setupTaskEnv('django/django', '3.0', repo, cache, SPECS)!;
    expect(venvBuilds()).toBe(1);
    expect(venvLooksIntact(first.venvDir, first.pythonBin)).toBe(true);
    setupTaskEnv('django/django', '3.0', repo, cache, SPECS);
    expect(venvBuilds()).toBe(1);
  });

  it('rebuilds a cached venv whose package METADATA was purged', () => {
    const env = setupTaskEnv('django/django', '3.0', repo, cache, SPECS)!;
    fs.rmSync(metadata(env.venvDir));
    expect(venvLooksIntact(env.venvDir, env.pythonBin)).toBe(false);
    setupTaskEnv('django/django', '3.0', repo, cache, SPECS);
    expect(venvBuilds()).toBe(2);
    expect(fs.existsSync(metadata(env.venvDir))).toBe(true);
  });

  it('rebuilds once when the editable install fails in a reused venv, then succeeds', () => {
    setupTaskEnv('django/django', '3.0', repo, cache, SPECS);
    failEditableInstalls = 1;
    expect(() => setupTaskEnv('django/django', '3.0', repo, cache, SPECS)).not.toThrow();
    expect(venvBuilds()).toBe(2);
  });

  it('does not loop: a fresh venv whose install fails throws', () => {
    failEditableInstalls = 5;
    expect(() => setupTaskEnv('django/django', '3.0', repo, cache, SPECS)).toThrow(/Failed to read/);
    expect(venvBuilds()).toBe(1);
  });

  it('labels an environment-build failure infra, not capability', () => {
    const err = new Error(
      'Command failed: /Users/x/.local/bin/uv pip install --python /Users/x/venvs/django_django@3.0/bin/python -e .\n' +
        '  × Failed to read `sqlparse==0.5.5`',
    );
    expect(classifyFailure(err).kind).toBe('infra');
    expect(classifyFailure(new Error('Command failed: uv venv --python 3.9 /v')).kind).toBe('infra');
    expect(classifyFailure(new Error('model produced no patch')).kind).toBe('capability');
  });
});

describe('defaultSweCacheDir (#208)', () => {
  it('is the user cache directory for each platform, never the temp dir', () => {
    expect(defaultSweCacheDir('darwin', {}, '/Users/u')).toBe(
      path.join('/Users/u', 'Library', 'Caches', 'sidecar-swe'),
    );
    expect(defaultSweCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')).toBe(
      path.join('C:\\Users\\u\\AppData\\Local', 'sidecar-swe'),
    );
    expect(defaultSweCacheDir('linux', { XDG_CACHE_HOME: '/home/u/.xdg' }, '/home/u')).toBe(
      path.join('/home/u/.xdg', 'sidecar-swe'),
    );
    expect(defaultSweCacheDir('linux', {}, '/home/u')).toBe(path.join('/home/u', '.cache', 'sidecar-swe'));
    expect(defaultSweCacheDir().startsWith(os.tmpdir())).toBe(false);
  });
});

describe('test dependencies in the venv (#216)', () => {
  const installs = () =>
    uvCalls
      .filter((a) => a[0] === 'pip')
      .map((a) => a.slice(a.indexOf('--python') + 2, a.includes('-c') ? a.indexOf('-c') : undefined).join(' '));
  const constraintsUsed = () => uvCalls.filter((a) => a[0] === 'pip' && a.includes('-c')).length;

  it('keeps the extras the spec install asks for', () => {
    const specs: SpecMap = {
      'sphinx-doc/sphinx': {
        '3.4': {
          python: '3.9',
          install: 'python -m pip install -e .[test]',
          test_cmd: 'tox --current-env -epy39 -v --',
        },
      },
    };
    setupTaskEnv('sphinx-doc/sphinx', '3.4', repo, cache, specs);
    expect(installs()).toContain('-e .[test]');
  });

  it('resolves under the setup.py pins and era pins, but not the spec pip_packages', () => {
    const specs: SpecMap = {
      'sphinx-doc/sphinx': {
        '3.4': {
          python: '3.9',
          pre_install: ["sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py"],
          pip_packages: ['Jinja2==3.0.3'],
          install: 'python -m pip install -e .[test]',
          test_cmd: 'tox --current-env -epy39 -v --',
        },
      },
    };
    const env = setupTaskEnv('sphinx-doc/sphinx', '3.4', repo, cache, specs)!;
    const pipCalls = uvCalls.filter((a) => a[0] === 'pip');
    expect(pipCalls.find((a) => a.includes('Jinja2==3.0.3'))).not.toContain('-c');
    expect(pipCalls.find((a) => a.includes('-e'))).toContain('-c');
    expect(constraintsUsed()).toBeGreaterThan(0);
    const file = fs.readFileSync(path.join(env.venvDir, '.sidecar-constraints.txt'), 'utf-8');
    expect(file.trim().split('\n')).toEqual(['Jinja2<3.0', 'setuptools<81', 'docutils<0.22']);
  });

  it('passes no constraints for a repo with none', () => {
    setupTaskEnv('django/django', '3.0', repo, cache, SPECS);
    expect(constraintsUsed()).toBe(0);
  });

  it('installs pytest into a pytest-runner venv that has none, once', () => {
    const specs: SpecMap = {
      'psf/requests': { '2.3': { python: '3.9', install: 'python -m pip install .', test_cmd: 'pytest -rA' } },
    };
    const env = setupTaskEnv('psf/requests', '2.3', repo, cache, specs)!;
    expect(installs()).toContain('pytest');
    expect(venvHasPytest(env.venvDir)).toBe(true);
    uvCalls.length = 0;
    setupTaskEnv('psf/requests', '2.3', repo, cache, specs);
    expect(installs()).not.toContain('pytest');
  });

  it('installs the repo test requirements SWE-bench uses before falling back to bare pytest', () => {
    const specs: SpecMap = {
      'pylint-dev/pylint': { '2.14': { python: '3.9', install: 'python -m pip install -e .', test_cmd: 'pytest -rA' } },
    };
    fs.writeFileSync(path.join(repo, 'requirements_test.txt'), 'pytest~=7.1\n');
    setupTaskEnv('pylint-dev/pylint', '2.14', repo, cache, specs);
    const all = installs();
    expect(all).toContain('-r requirements_test.txt');
    expect(all.indexOf('-r requirements_test.txt')).toBeLessThan(all.indexOf('pytest'));
  });

  it('does not install pytest for django or sympy runners', () => {
    const specs: SpecMap = {
      'sympy/sympy': { '1.0': { python: '3.9', test_cmd: "PYTHONWARNINGS='ignore' bin/test -C --verbose" } },
    };
    setupTaskEnv('django/django', '3.0', repo, cache, {
      'django/django': { '3.0': { python: '3.9', test_cmd: './tests/runtests.py' } },
    });
    setupTaskEnv('sympy/sympy', '1.0', repo, cache, specs);
    expect(installs()).not.toContain('pytest');
  });

  it('rebuilds a cached venv built by an older recipe or for a different spec', () => {
    const env = setupTaskEnv('django/django', '3.0', repo, cache, SPECS)!;
    expect(venvBuilds()).toBe(1);
    // A marker from before #216 carries no recipe hash.
    fs.writeFileSync(path.join(env.venvDir, '.sidecar-ready'), 'django/django@3.0 python=3.9\n');
    setupTaskEnv('django/django', '3.0', repo, cache, SPECS);
    expect(venvBuilds()).toBe(2);
    setupTaskEnv('django/django', '3.0', repo, cache, SPECS);
    expect(venvBuilds()).toBe(2);
    setupTaskEnv('django/django', '3.0', repo, cache, {
      'django/django': { '3.0': { python: '3.9', pip_packages: ['sqlparse'] } },
    });
    expect(venvBuilds()).toBe(3);
  });
});
