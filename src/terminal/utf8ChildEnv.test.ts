import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import os from 'os';
import { withUtf8ChildEnv } from './utf8ChildEnv.js';
import { ShellSession } from './shellSession.js';

describe('withUtf8ChildEnv', () => {
  it('forces Python to UTF-8 on Windows', () => {
    const env = withUtf8ChildEnv({ PATH: 'x' }, true);
    expect(env).toEqual({ PATH: 'x', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  });

  it("keeps the user's own settings", () => {
    expect(withUtf8ChildEnv({ PYTHONUTF8: '0', PYTHONIOENCODING: 'latin-1' }, true)).toEqual({
      PYTHONUTF8: '0',
      PYTHONIOENCODING: 'latin-1',
    });
  });

  it('changes nothing off Windows', () => {
    const env = { PATH: 'x' };
    expect(withUtf8ChildEnv(env, false)).toBe(env);
  });
});

// The real failure: SideCar decodes command output as UTF-8, and Python on
// Windows writing to a pipe used cp1252 -- ✓ and → raised UnicodeEncodeError.
const hasPython = (() => {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(os.platform() !== 'win32' || !hasPython)('ShellSession runs Python in UTF-8 on Windows', () => {
  it('prints non-ASCII text intact instead of crashing or garbling it', async () => {
    const session = new ShellSession(os.tmpdir());
    try {
      const r = await session.execute(`python -c "print('ok \\u2713 \\u2192 caf\\u00e9')"`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ok ✓ → café');
      expect(r.stdout).not.toContain('UnicodeEncodeError');
      expect(r.stdout).not.toContain('�');
    } finally {
      session.dispose();
    }
  }, 30_000);
});
