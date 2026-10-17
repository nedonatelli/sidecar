import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSandboxProfile, isSeatbeltSupported } from './seatbelt.js';

// The profile was UNPARSEABLE and nothing noticed. `(local)` with no filter
// argument crashed sandbox-exec's SBPL parser:
//
//   Assertion failed: (is_pair(p)), function car, file sbpl_parser.c, line 129
//
// sandbox-exec then aborted before exec'ing the shell, so ShellSession waited
// for a completion sentinel from a process that never started — every command
// hung until timeout, not just stdin-readers. It stayed invisible because with
// VS Code shell integration attached commands run in the terminal instead,
// unsandboxed, and never reach this path.
//
// Unit-testing the profile STRING cannot catch this. Only the real parser can,
// so this test runs the real parser.

const describeMac = process.platform === 'darwin' && isSeatbeltSupported() ? describe : describe.skip;

describeMac('seatbelt profile', () => {
  it('is accepted by the real SBPL parser', () => {
    const profile = buildSandboxProfile(process.cwd());
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbpl-')), 'p.sbpl');
    fs.writeFileSync(file, profile, 'utf-8');
    // A profile that fails to parse makes sandbox-exec abort; a profile that
    // parses runs the command and echoes back.
    const out = execFileSync('/usr/bin/sandbox-exec', ['-f', file, '/bin/echo', 'PARSED'], {
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(out.trim()).toBe('PARSED');
  });

  it('permits writes inside the workspace and denies them outside', () => {
    const profile = buildSandboxProfile(process.cwd());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbpl-'));
    const file = path.join(dir, 'p.sbpl');
    fs.writeFileSync(file, profile, 'utf-8');
    const target = path.join(process.cwd(), 'dogfood-tmp-sbpl-probe.txt');

    // Inside the workspace: allowed.
    execFileSync('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/touch', target], { timeout: 15_000 });
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(target, { force: true });

    // Outside it (a sibling of the home dir): denied. The whole point of the
    // sandbox is that this throws.
    let denied = false;
    try {
      execFileSync(
        '/usr/bin/sandbox-exec',
        ['-f', file, '/usr/bin/touch', path.join(os.homedir(), '.sbpl-should-fail')],
        {
          timeout: 15_000,
          stdio: 'ignore',
        },
      );
    } catch {
      denied = true;
    }
    fs.rmSync(path.join(os.homedir(), '.sbpl-should-fail'), { force: true });
    expect(denied, 'sandbox permitted a write outside the workspace').toBe(true);
  });

  // c25cc40e's hook-manager / submodule / nested-repo denials shipped
  // text-tested only. A deny rule the real sandbox ignores (or one that also
  // catches ordinary git writes) is invisible to a profile-string test.
  describe('inside a git workspace', () => {
    let ws: string;
    let profileFile: string;

    beforeAll(() => {
      ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbpl-ws-')));
      execFileSync('git', ['init', '-q'], { cwd: ws });
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
        {
          cwd: ws,
        },
      );
      fs.mkdirSync(path.join(ws, '.git/modules/sub/hooks'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.git/modules/sub/config'), '');
      fs.mkdirSync(path.join(ws, 'pkg'));
      profileFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbpl-')), 'p.sbpl');
      fs.writeFileSync(profileFile, buildSandboxProfile(ws), 'utf-8');
    });

    afterAll(() => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(path.dirname(profileFile), { recursive: true, force: true });
    });

    const sandboxed = (cmd: string) =>
      spawnSync('/usr/bin/sandbox-exec', ['-f', profileFile, '/bin/sh', '-c', cmd], { cwd: ws, timeout: 15_000 });

    it.each([
      'mkdir .husky',
      'mkdir .githooks',
      'echo x > .pre-commit-config.yaml',
      'echo x > .pre-commit-config.yml',
      'echo x > lefthook.yml',
      'echo x > lefthook.yaml',
      'echo x > .lefthook.yml',
      'echo x > .gitmodules',
      'echo x > .git/modules/sub/config',
      'echo x > .git/modules/sub/hooks/post-checkout',
      'mkdir pkg/.git',
      'git init -q pkg',
      'echo "gitdir: /tmp" > pkg/.git',
    ])('denies %s', (cmd) => {
      expect(sandboxed(cmd).status).not.toBe(0);
    });

    it('still runs ordinary writes and git work', () => {
      const g = '-c user.email=t@t -c user.name=t';
      for (const cmd of [
        'mkdir -p deep/dir && echo x > deep/dir/a.txt && echo x > pkg/mod.py && echo x > .gitignore',
        'echo x > a.py && git add a.py',
        `git ${g} commit -q -m one`,
        'git checkout -q -b feature',
        'echo y >> a.py && git stash -q && git stash pop -q',
        `git ${g} commit -qam two`,
        'git checkout -q - && git merge -q --ff-only feature',
      ]) {
        const r = sandboxed(cmd);
        expect(r.status, `${cmd}: ${r.stderr.toString()}`).toBe(0);
      }
    });
  });
});
