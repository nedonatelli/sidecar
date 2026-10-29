import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isolateShellEnv, prepareScratchDir, pythonRuns } from './shellIsolation.js';

describe('isolateShellEnv', () => {
  it('points temp and home at the scratch folder and turns off the Python user site', () => {
    const env = isolateShellEnv(
      { PATH: '/usr/bin', TMPDIR: '/var/tmp', HOME: '/home/u', UNSET: undefined },
      '/s',
      'linux',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      TMP: path.join('/s', 'tmp'),
      TEMP: path.join('/s', 'tmp'),
      TMPDIR: path.join('/s', 'tmp'),
      HOME: path.join('/s', 'home'),
      PYTHONNOUSERSITE: '1',
    });
  });

  it('on Windows, overrides a key under the spelling the environment already has', () => {
    const env = isolateShellEnv({ Temp: 'C:\\Users\\u\\AppData\\Local\\Temp', Path: 'C:\\x' }, 'C:\\s', 'win32');
    expect(env.Temp).toBe(path.join('C:\\s', 'tmp'));
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'TEMP')).toEqual(['Temp']);
    expect(env.Path).toBe('C:\\x');
  });

  it('leaves USERPROFILE alone: Windows programs read it', () => {
    const env = isolateShellEnv({ USERPROFILE: 'C:\\Users\\u' }, 'C:\\s', 'win32');
    expect(env.USERPROFILE).toBe('C:\\Users\\u');
  });
});

describe('prepareScratchDir', () => {
  it('creates empty tmp and home folders, clearing what a previous run left', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-test-'));
    const first = prepareScratchDir(root, 'astropy__astropy-12907', 'scaffold-on');
    fs.writeFileSync(path.join(first, 'tmp', 'leftover'), 'x');
    const again = prepareScratchDir(root, 'astropy__astropy-12907', 'scaffold-on');
    expect(again).toBe(first);
    expect(fs.readdirSync(path.join(again, 'tmp'))).toEqual([]);
    expect(fs.existsSync(path.join(again, 'home'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('pythonRuns', () => {
  it('is true when python runs', () => {
    const run = vi.fn();
    expect(pythonRuns({}, run as never)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('falls back to python3', () => {
    const run = vi.fn().mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(pythonRuns({}, run as never)).toBe(true);
    expect(run.mock.calls[1][0]).toBe('python3');
  });

  it('is false when neither runs (missing, or the Windows Store alias)', () => {
    const run = vi.fn(() => {
      throw new Error('exit 9009');
    });
    expect(pythonRuns({}, run as never)).toBe(false);
  });
});
