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
    if (args[0] === 'pip' && args.includes('-e') && failEditableInstalls > 0) {
      failEditableInstalls--;
      throw new Error('Command failed: uv pip install --python x -e .\n  × Failed to read `sqlparse==0.5.5`');
    }
    return Buffer.from('');
  },
}));

import { setupTaskEnv, venvLooksIntact, defaultSweCacheDir, type SpecMap } from './taskEnv.js';
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
