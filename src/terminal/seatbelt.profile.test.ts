import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
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
});
