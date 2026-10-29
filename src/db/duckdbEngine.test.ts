import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configureDuckDbEngine,
  installDuckDbEngine,
  isDuckDbEngineInstalled,
  loadDuckDb,
  removeDuckDbEngine,
  DUCKDB_ENGINE_PACKAGE,
  type NpmRunner,
} from './duckdbEngine.js';

// DuckDB is opt-in (#364): the user installs the engine with the command, or
// points sidecar.databases.duckdbPath at an install they already have. These
// use fake @duckdb/node-api packages in temp folders.

let tmp: string;

/** Write a fake @duckdb/node-api whose module exports `{ marker }`, or throws when `broken`. */
function fakePackage(root: string, marker: string, broken = false): string {
  const dir = path.join(root, 'node_modules', '@duckdb', 'node-api');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@duckdb/node-api', main: 'index.js' }));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    broken
      ? "throw new Error('binding for the wrong platform');"
      : `module.exports = { marker: ${JSON.stringify(marker)} };`,
  );
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duckdb-engine-'));
  configureDuckDbEngine({ engineDir: path.join(tmp, 'engine'), configuredPath: () => undefined });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loadDuckDb', () => {
  it('loads the package folder sidecar.databases.duckdbPath names', async () => {
    const pkg = fakePackage(path.join(tmp, 'elsewhere'), 'configured-pkg');
    configureDuckDbEngine({ engineDir: path.join(tmp, 'engine'), configuredPath: () => pkg });
    expect(await loadDuckDb<{ marker: string }>()).toEqual({ marker: 'configured-pkg' });
  });

  it('loads from a folder whose node_modules holds it (a project, or the global npm folder)', async () => {
    const project = path.join(tmp, 'project');
    fakePackage(project, 'configured-parent');
    configureDuckDbEngine({ engineDir: path.join(tmp, 'engine'), configuredPath: () => project });
    expect(await loadDuckDb<{ marker: string }>()).toEqual({ marker: 'configured-parent' });
  });

  it('prefers the configured path over the engine SideCar installed', async () => {
    fakePackage(path.join(tmp, 'engine'), 'engine');
    const project = path.join(tmp, 'project');
    fakePackage(project, 'configured');
    configureDuckDbEngine({ engineDir: path.join(tmp, 'engine'), configuredPath: () => project });
    expect(await loadDuckDb<{ marker: string }>()).toEqual({ marker: 'configured' });
  });

  it('a configured path with no DuckDB says so instead of falling through', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    configureDuckDbEngine({ engineDir: path.join(tmp, 'engine'), configuredPath: () => empty });
    await expect(loadDuckDb()).rejects.toThrow(/duckdbPath is ".*empty", but no @duckdb\/node-api was found there/);
  });

  it('uses the engine SideCar installed when no path is configured', async () => {
    fakePackage(path.join(tmp, 'engine'), 'engine');
    expect(await loadDuckDb<{ marker: string }>()).toEqual({ marker: 'engine' });
  });

  it('a copy that is found but fails to load reports its own error', async () => {
    fakePackage(path.join(tmp, 'engine'), 'engine', true);
    await expect(loadDuckDb()).rejects.toThrow(/failed to load: .*wrong platform/);
  });

  it('never loads a copy from the open project unless the setting points at it', async () => {
    // There is no workspace fallback: a cloned repo's own
    // node_modules/@duckdb/node-api must not run on the first DuckDB query.
    const repo = path.join(tmp, 'cloned-repo');
    fakePackage(repo, 'from-the-repo');
    const loaded = await loadDuckDb<{ marker?: string }>().catch((): { marker?: string } => ({}));
    expect(loaded.marker).not.toBe('from-the-repo');
  });
});

describe('installDuckDbEngine', () => {
  it('runs npm install for the pinned package in the engine folder', async () => {
    const dir = path.join(tmp, 'engine');
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const run: NpmRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      fakePackage(cwd, 'installed');
      return { code: 0, output: 'added 3 packages' };
    };
    await installDuckDbEngine(dir, run);
    expect(calls).toEqual([
      { args: ['install', '--no-audit', '--no-fund', '--omit=dev', DUCKDB_ENGINE_PACKAGE], cwd: dir },
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))).toMatchObject({ private: true });
    expect(isDuckDbEngineInstalled(dir)).toBe(true);
    expect(await loadDuckDb<{ marker: string }>()).toEqual({ marker: 'installed' });
  });

  it("reports npm's exit code and the end of its output when the install fails", async () => {
    const run: NpmRunner = async () => ({ code: 1, output: 'npm ERR! code E404\nnpm ERR! 404 Not Found' });
    await expect(installDuckDbEngine(path.join(tmp, 'engine'), run)).rejects.toThrow(/exit 1\)\.\n.*E404/s);
  });

  it('says to install Node.js when npm cannot be started', async () => {
    const run: NpmRunner = async () => ({ code: null, output: 'Error: spawn npm ENOENT' });
    await expect(installDuckDbEngine(path.join(tmp, 'engine'), run)).rejects.toThrow(/npm could not be started/);
  });

  it('removeDuckDbEngine takes the installed engine away', async () => {
    const dir = path.join(tmp, 'engine');
    fakePackage(dir, 'installed');
    expect(isDuckDbEngineInstalled(dir)).toBe(true);
    removeDuckDbEngine(dir);
    expect(isDuckDbEngineInstalled(dir)).toBe(false);
  });
});
