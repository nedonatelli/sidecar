import { describe, it, expect, afterEach } from 'vitest';
import { ShellSession } from './shellSession.js';
import * as os from 'os';

// Skip on Windows CI — these tests use bash
const isWindows = os.platform() === 'win32';
const describeUnix = isWindows ? describe.skip : describe;

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
});
