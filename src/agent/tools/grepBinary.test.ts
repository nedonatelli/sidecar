import { describe, it, expect } from 'vitest';
import { isGrepMissing, resolveGrepBinary } from './grepArgs.js';

// Paths compared case-insensitively, the way Windows resolves them.
const fsWith =
  (...files: string[]) =>
  (file: string) =>
    files.some((f) => f.toLowerCase() === file.toLowerCase());

describe('resolveGrepBinary', () => {
  it('is plain grep off Windows, without looking at the disk', () => {
    const exists = () => {
      throw new Error('should not be called');
    };
    expect(resolveGrepBinary('linux', { PATH: '/usr/bin' }, exists)).toBe('grep');
    expect(resolveGrepBinary('darwin', {}, exists)).toBe('grep');
  });

  it('keeps grep when one is already on PATH', () => {
    const env = { Path: 'C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\usr\\bin' };
    const exists = fsWith('C:\\Program Files\\Git\\usr\\bin\\grep.exe', 'C:\\Program Files\\Git\\cmd\\git.exe');
    expect(resolveGrepBinary('win32', env, exists)).toBe('grep');
  });

  it("uses the grep beside the git on PATH (Git for Windows' default: only <Git>\\cmd)", () => {
    const env = { Path: 'C:\\Windows\\system32;D:\\Tools\\Git\\cmd' };
    const exists = fsWith('D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\usr\\bin\\grep.exe');
    expect(resolveGrepBinary('win32', env, exists)).toBe('D:\\Tools\\Git\\usr\\bin\\grep.exe');
  });

  it('finds the install from <Git>\\bin and <Git>\\mingw64\\bin too', () => {
    const grepExe = 'D:\\Git\\usr\\bin\\grep.exe';
    expect(resolveGrepBinary('win32', { PATH: 'D:\\Git\\bin' }, fsWith('D:\\Git\\bin\\git.exe', grepExe))).toBe(
      grepExe,
    );
    expect(
      resolveGrepBinary(
        'win32',
        { PATH: 'D:\\Git\\mingw64\\bin\\' },
        fsWith('D:\\Git\\mingw64\\bin\\git.exe', grepExe),
      ),
    ).toBe(grepExe);
  });

  it('falls back to the standard install folders when git is not on PATH', () => {
    const env = { Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const userInstall = 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\usr\\bin\\grep.exe';
    expect(resolveGrepBinary('win32', env, fsWith(userInstall))).toBe(userInstall);
    const machine = { ...env, ProgramFiles: 'C:\\Program Files' };
    expect(resolveGrepBinary('win32', machine, fsWith('C:\\Program Files\\Git\\usr\\bin\\grep.exe'))).toBe(
      'C:\\Program Files\\Git\\usr\\bin\\grep.exe',
    );
  });

  it('returns grep when there is none anywhere, so the failure is the ENOENT the tool reports', () => {
    expect(resolveGrepBinary('win32', { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, fsWith())).toBe(
      'grep',
    );
  });
});

describe('isGrepMissing', () => {
  it('is true only for a missing executable', () => {
    expect(isGrepMissing(Object.assign(new Error('spawn grep ENOENT'), { code: 'ENOENT' }))).toBe(true);
    expect(isGrepMissing(Object.assign(new Error('no match'), { code: 1 }))).toBe(false);
    expect(isGrepMissing(null)).toBe(false);
  });
});
