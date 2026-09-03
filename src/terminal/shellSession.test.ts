import { describe, it, expect, afterEach } from 'vitest';
import { ShellSession } from './shellSession.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Skip on Windows CI — these tests use bash
const isWindows = os.platform() === 'win32';
const describeUnix = isWindows ? describe.skip : describe;
// The suite above is bash-only, so until now nothing exercised the Windows
// shell path at all — which is how cmd.exe's startup banner reached the model
// as a command's output without any test noticing.
const describeWindows = isWindows ? describe : describe.skip;

describeUnix('ShellSession', () => {
  let session: ShellSession;

  afterEach(() => {
    session?.dispose();
  });

  it('executes a simple command and returns output', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('echo hello');
    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures exit codes from failed commands', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('ls /nonexistent_path_xyz 2>&1');
    expect(result.exitCode).not.toBe(0);
  });

  it('captures exit codes via subcommand', async () => {
    session = new ShellSession(os.tmpdir());
    // Use a subshell so `exit` doesn't kill the persistent shell
    const result = await session.execute('bash -c "exit 42"');
    expect(result.exitCode).toBe(42);
  });

  it('persists environment variables between commands', async () => {
    session = new ShellSession(os.tmpdir());
    await session.execute('export MY_TEST_VAR=sidecar123');
    const result = await session.execute('echo $MY_TEST_VAR');
    expect(result.stdout).toContain('sidecar123');
  });

  it('persists working directory between commands', async () => {
    session = new ShellSession(os.tmpdir());
    await session.execute('cd /usr');
    const result = await session.execute('pwd');
    expect(result.stdout).toContain('/usr');
  });

  it('handles command timeout', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('sleep 10', { timeout: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('timed out');
  });

  // The timeout guards against a HUNG process, not a slow one. A wall-clock
  // kill cannot tell the two apart: it killed django's test suite at exactly
  // 120s in a SWE-bench run while the suite was actively emitting 680 KB of
  // output, ten times across five arms — ~20 minutes of a 39-minute run spent
  // producing no test signal at all.
  it('does not kill a long command that keeps producing output', async () => {
    session = new ShellSession(os.tmpdir());
    // Runs ~1.6s total, emitting every ~200ms — never silent for the 700ms
    // idle window. Under a wall-clock timeout this is killed at 700ms.
    const result = await session.execute('for i in 1 2 3 4 5 6 7 8; do echo tick; sleep 0.2; done', {
      timeout: 700,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tick');
  });

  it('still kills a hung command that produces no output', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('sleep 30', { timeout: 500 });
    expect(result.timedOut).toBe(true);
  });

  // The truncation reassembly rebuilds stdout from the failure-tail ring, which
  // dropped the timeout notice appended to `output`. Observed live: django's
  // suite flooded output, got truncated, timed out at exit -1 — and the model,
  // seeing no timeout marker, re-ran the identical command three times.
  it('surfaces the timeout notice even when output was truncated', async () => {
    session = new ShellSession(os.tmpdir(), undefined, 2000);
    const result = await session.execute(
      'for i in $(seq 1 300); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done; sleep 30',
      { timeout: 700 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('timed out');
  });

  it('enforces an absolute ceiling even while output keeps flowing', async () => {
    session = new ShellSession(os.tmpdir());
    // Never idle, so only the absolute cap can stop it — the `tail -f` case.
    const result = await session.execute('while true; do echo spin; sleep 0.1; done', {
      timeout: 5000,
      maxTimeout: 800,
    });
    expect(result.timedOut).toBe(true);
  });

  it('streams output via onOutput callback', async () => {
    session = new ShellSession(os.tmpdir());
    const chunks: string[] = [];
    const result = await session.execute('echo line1; echo line2; echo line3', {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line3');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('serializes concurrent commands', async () => {
    session = new ShellSession(os.tmpdir());
    // Fire two commands concurrently — they should not interleave
    const [r1, r2] = await Promise.all([session.execute('echo first'), session.execute('echo second')]);
    expect(r1.stdout).toContain('first');
    expect(r2.stdout).toContain('second');
  });

  it('handles stderr merged into stdout', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('echo err >&2');
    expect(result.stdout).toContain('err');
  });

  it('respects abort signal', async () => {
    session = new ShellSession(os.tmpdir());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await session.execute('sleep 10', { signal: controller.signal });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('aborted');
  });

  it('respawns after process dies', async () => {
    session = new ShellSession(os.tmpdir());
    await session.execute('echo alive');
    session.dispose();
    // After dispose, isAlive should be false but next execute should respawn
    const result = await session.execute('echo respawned');
    expect(result.stdout).toContain('respawned');
  });

  it('unblocks the next command promptly after a timeout (proc.kill regression)', async () => {
    // Without proc.kill() in the timeout handler, the shell would continue
    // running `sleep 60` and the next command would be queued behind it,
    // blocking for ~60 s.  With the fix the shell is killed on timeout and
    // a fresh shell is spawned for the next execute() call.
    session = new ShellSession(os.tmpdir());
    const timedOut = await session.execute('sleep 60', { timeout: 200 });
    expect(timedOut.timedOut).toBe(true);

    const start = Date.now();
    const next = await session.execute('echo hello', { timeout: 5000 });
    const elapsed = Date.now() - start;

    expect(next.stdout).toContain('hello');
    // If proc.kill() did NOT fire, the next command would have to wait for
    // sleep 60 to finish naturally (~60 s).  Verify it ran well under that.
    expect(elapsed).toBeLessThan(5000);
  });

  it('unblocks the next command promptly after an abort', async () => {
    session = new ShellSession(os.tmpdir());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const aborted = await session.execute('sleep 60', { signal: controller.signal });
    expect(aborted.timedOut).toBe(true);

    const start = Date.now();
    const next = await session.execute('echo world', { timeout: 5000 });
    const elapsed = Date.now() - start;

    expect(next.stdout).toContain('world');
    expect(elapsed).toBeLessThan(5000);
  });

  it('manages background commands', async () => {
    session = new ShellSession(os.tmpdir());
    const id = session.executeBackground('echo bg_output; sleep 0.1');
    expect(typeof id).toBe('string');

    // Wait for it to finish
    await new Promise((r) => setTimeout(r, 500));
    const status = session.checkBackground(id);
    expect(status).not.toBeNull();
    expect(status!.done).toBe(true);
    expect(status!.output).toContain('bg_output');
  });

  it('wipes shell functions defined in prior turns (state-pollution guard)', async () => {
    // Canonical cycle-2 audit attack: an earlier turn installs a
    // malicious shell function, a later turn calls the shadowed
    // command, and the user approves it thinking it's innocuous.
    // After the hardening prefix runs, the function should be gone
    // and the real command should execute.
    //
    // We probe by invoking the function directly rather than with
    // `declare -F` — zsh's `declare` doesn't differentiate defined
    // vs undefined functions, but a missing command returns non-zero
    // in every POSIX shell.
    session = new ShellSession(os.tmpdir());
    await session.execute('poisoned() { echo "PWNED"; }; echo "defined ok"');
    const result = await session.execute('poisoned 2>/dev/null && echo "still there" || echo "cleaned"');
    expect(result.stdout).toContain('cleaned');
    expect(result.stdout).not.toContain('PWNED');
  });

  it('preserves legitimate env vars and cwd across commands (no over-scrub)', async () => {
    // Regression: the hardening must not wipe the env vars or cwd the
    // persistent shell session is there to track. Existing tests cover
    // this for normal commands; this one runs *after* the function
    // hardening path to make sure the prefix doesn't accidentally reset
    // exported variables too.
    session = new ShellSession(os.tmpdir());
    await session.execute('export PERSIST_VAR=keep_me; helper_fn() { echo nope; }');
    const result = await session.execute('echo $PERSIST_VAR');
    expect(result.stdout).toContain('keep_me');
  });

  describe('accumulated-output integrity across the sentinel boundary', () => {
    // Regression: checkSentinel used to `output = preOutput`, which
    // discarded every byte from prior chunks for any command whose
    // output exceeded a single ~200-char buffer window. No existing
    // test caught this because they all used short commands.

    it('preserves every line from a multi-chunk command run', async () => {
      // ~5 KB of output guarantees multiple buffer trim cycles before
      // the sentinel arrives — the bug path.
      session = new ShellSession(os.tmpdir(), undefined, 100 * 1024);
      const result = await session.execute('for i in $(seq 1 200); do printf "LINE_%03d\\n" "$i"; done');
      expect(result.exitCode).toBe(0);
      // Every line 001–200 must appear in the captured output. Prior
      // to the fix, only the tail ~200 chars survived. The final line
      // doesn't carry a trailing newline because checkSentinel strips
      // one (`.replace(/\n$/, '')`), so assert on the bare form.
      expect(result.stdout).toContain('LINE_001\n');
      expect(result.stdout).toContain('LINE_100\n');
      expect(result.stdout).toContain('LINE_200');
    });
  });

  describe('tail-preferred truncation on non-zero exit (audit cycle-2 MEDIUM #15)', () => {
    // Each test spawns a fresh session with a tight maxOutputSize so a
    // brief shell command reliably overflows the buffer and triggers
    // truncation. That exercises the wasTruncated path and the
    // failureTailRing assembly without needing megabytes of output.
    // Commands that should produce non-zero exit are wrapped in
    // `bash -c` so `exit N` doesn't kill the persistent outer shell
    // (same pattern as the existing "captures exit codes via subcommand"
    // test at line ~33).

    it('keeps head+tail assembly when the truncated command exits zero', async () => {
      // maxOutputSize = 1024 means 512-byte head + 307-byte ring + marker
      session = new ShellSession(os.tmpdir(), undefined, 1024);
      const result = await session.execute('for i in $(seq 1 200); do printf "LINE_%03d_aaaaaaaaaaaa\\n" "$i"; done');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('output truncated');
      // Zero-exit path keeps head bytes — the early lines must survive.
      expect(result.stdout).toContain('LINE_001_');
      // Tail also preserved via ring.
      expect(result.stdout).toContain('LINE_200_');
    });

    it('rewrites to tail-only when the truncated command exits non-zero', async () => {
      session = new ShellSession(os.tmpdir(), undefined, 1024);
      const result = await session.execute(
        'bash -c \'for i in $(seq 1 200); do printf "LINE_%03d_bbbbbbbbbbbb\\n" "$i"; done; exit 7\'',
      );
      expect(result.exitCode).toBe(7);
      // Non-zero-exit path drops the head and spends the full byte
      // budget on the tail. The marker explicitly says so.
      expect(result.stdout).toContain('command exited 7');
      expect(result.stdout).toContain('head dropped');
      // Early lines are gone; late lines (where errors live in real runs)
      // are preserved.
      expect(result.stdout).not.toContain('LINE_001_');
      expect(result.stdout).toContain('LINE_200_');
    });

    it('does not invoke the failure-tail rewrite when output never exceeded the cap', async () => {
      session = new ShellSession(os.tmpdir(), undefined, 1024);
      // Small failing command — exits non-zero but output is tiny,
      // so no truncation should happen and no failure-tail marker
      // should appear.
      const result = await session.execute("bash -c 'echo quick_fail; exit 3'");
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain('quick_fail');
      expect(result.stdout).not.toContain('head dropped');
      expect(result.stdout).not.toContain('output truncated');
    });
  });
});

describeUnix('stdin never reaches the command (sentinel-swallowing regression)', () => {
  let session: ShellSession;
  afterEach(() => session?.dispose());

  it('a stdin-reading command does not swallow the completion sentinel', async () => {
    // Live bug: completion is signalled by writing `echo "<SENTINEL>_$?_END"`
    // as a second line to the shell's stdin. `cat` read that line and printed
    // it, so stdout came back as `echo "` — and the exit code was parsed out
    // of the echoed text, reporting 0 for a command that never completed.
    session = new ShellSession(os.tmpdir());
    const r = await session.execute('cat');
    expect(r.stdout).not.toContain('echo');
    expect(r.stdout.trim()).toBe('');
  }, 30000);

  it('an interactive-style read gets EOF instead of hanging', async () => {
    session = new ShellSession(os.tmpdir());
    const r = await session.execute('read -r line; echo "got:[$line]"');
    expect(r.stdout).toContain('got:[]');
    expect(r.stdout).not.toContain('_END');
  }, 30000);

  // The grouping is what makes the redirect safe; each of these is a construct
  // it could plausibly break.
  it('pipelines still work (the reason for a group, not a bare redirect)', async () => {
    session = new ShellSession(os.tmpdir());
    // `echo x | cat < /dev/null` would bind the redirect to cat and print
    // nothing. Grouping keeps the pipe intact.
    const r = await session.execute('echo x | cat');
    expect(r.stdout.trim()).toBe('x');
  }, 30000);

  it('cd persists across calls (braces, not a subshell)', async () => {
    session = new ShellSession(os.tmpdir());
    await session.execute('cd /');
    const r = await session.execute('pwd');
    expect(r.stdout.trim()).toBe('/');
  }, 30000);

  it('exports persist across calls', async () => {
    session = new ShellSession(os.tmpdir());
    await session.execute('export SIDECAR_PROBE=42');
    const r = await session.execute('echo "v=$SIDECAR_PROBE"');
    expect(r.stdout.trim()).toBe('v=42');
  }, 30000);

  it('a trailing & does not become a syntax error', async () => {
    // `{ sleep 0 & ; }` is invalid — the newline before the closing brace is
    // what makes this work.
    session = new ShellSession(os.tmpdir());
    const r = await session.execute('sleep 0 &');
    expect(r.stdout).not.toMatch(/syntax error/i);
    expect(r.exitCode).toBe(0);
  }, 30000);

  it('a trailing comment does not swallow the terminator', async () => {
    session = new ShellSession(os.tmpdir());
    const r = await session.execute('echo hi # trailing comment');
    expect(r.stdout.trim()).toBe('hi');
  }, 30000);

  it('heredocs still work', async () => {
    session = new ShellSession(os.tmpdir());
    const r = await session.execute('cat <<EOF\nline1\nline2\nEOF');
    expect(r.stdout).toContain('line1');
    expect(r.stdout).toContain('line2');
  }, 30000);

  it('exit codes are the command’s, not parsed out of echoed text', async () => {
    session = new ShellSession(os.tmpdir());
    const ok = await session.execute('true');
    const bad = await session.execute('false');
    expect({ ok: ok.exitCode, bad: bad.exitCode }).toEqual({ ok: 0, bad: 1 });
  }, 30000);

  it('stderr is still captured', async () => {
    session = new ShellSession(os.tmpdir());
    const r = await session.execute('echo to-stderr 1>&2');
    expect(r.stdout).toContain('to-stderr');
  }, 30000);
});

describeWindows("ShellSession on Windows — output is the command's, and only the command's", () => {
  let session: ShellSession;

  afterEach(() => {
    session?.dispose();
  });

  it('does not leak the cmd.exe startup banner into the first command', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('echo hello');
    expect(result.stdout).toContain('hello');
    // The banner is only ever emitted once, at startup, so the first command is
    // the one that captured it. `jq ... package.json` returning "Microsoft
    // Windows [Version ...]" is what this prevents.
    expect(result.stdout).not.toMatch(/Microsoft Windows \[Version/);
    expect(result.stdout).not.toMatch(/All rights reserved/);
    expect(result.exitCode).toBe(0);
  });

  it('does not prefix output with the cmd.exe prompt', async () => {
    session = new ShellSession(os.tmpdir());
    const result = await session.execute('echo hello');
    // `C:\some\path>` before the output. A prompt is any drive-rooted path
    // ending in '>', which is never legitimate output for `echo hello`.
    expect(result.stdout).not.toMatch(/[A-Za-z]:\\[^\n]*>/);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('runs the POSIX-shaped commands cmd.exe rejects', async () => {
    // Measured on a 50-task SWE-bench run under cmd.exe: 237 rejections of
    // `./script` ("'.' is not recognized") plus ~100 more for bin/…, export, rg
    // and tox — about 4.7 per task, on a corpus of POSIX repos where
    // `./tests/runtests.py` is the documented way to run the suite. The agent
    // burned turns on shell syntax instead of the task.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-posix-'));
    fs.writeFileSync(path.join(dir, 'runtests.py'), "#!/usr/bin/env python\nprint('ran')\n");
    session = new ShellSession(dir);

    const ls = await session.execute('ls -1');
    expect(ls.stdout).toContain('runtests.py');
    expect(ls.stdout).not.toMatch(/is not recognized/);

    const exported = await session.execute('export FOO=bar && echo $FOO');
    expect(exported.stdout).toContain('bar');

    // The point is that `./x` RESOLVES. Whether the script then runs depends on
    // its interpreter, which is not what this pins.
    const dotSlash = await session.execute('./runtests.py 2>&1 || true');
    expect(dotSlash.stdout).not.toMatch(/is not recognized/);
  }, 60_000);

  it('keeps later commands clean too, and preserves exit codes', async () => {
    session = new ShellSession(os.tmpdir());
    await session.execute('echo first');
    const second = await session.execute('echo second');
    expect(second.stdout.trim()).toBe('second');
    expect(second.stdout).not.toMatch(/Microsoft Windows \[Version/);
    expect(second.exitCode).toBe(0);

    // A subshell, so the exit does not kill the session's own shell. Written in
    // POSIX form because the Windows shell is now Git Bash when it is installed
    // — and note `cmd /c exit 3` does NOT work here: MSYS rewrites the `/c`
    // argument into a path, so cmd never sees the switch and exits 0.
    const failed = await session.execute('(exit 3)');
    expect(failed.exitCode).toBe(3);
  }, 30_000);
});
