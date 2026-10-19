import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShellSession } from '../../src/terminal/shellSession.js';
import type { RegisteredTool } from '../../src/agent/tools/shared.js';
import {
  ShellRootGuard,
  shellGuardTools,
  returnedNote,
  mayChangeDirectory,
  resolveRootWithBash,
  type GuardShell,
} from './shellGuard.js';

// A real ShellSession: the bug is the session's own cwd persistence, so the
// guard is only proven against the real thing (Git Bash on Windows, bash/zsh
// elsewhere).
let root: string;
let outside: string;
let session: ShellSession;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-root-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'mod.py'), 'x = 1\n');
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-outside-')));
  session = new ShellSession(root);
});

// dispose() asks for the shell to be killed and returns; on Windows the dying
// shell still holds `root` as its cwd for a while, and removing it fails with
// EPERM. That was the intermittent pre-commit failure, worse under load: three
// tests in one hook run while a 31b eval ran, and still one with rmSync's
// ~1 s of blocking retries. fs.promises.rm retries EPERM with a growing delay
// (up to ~20 s here) and doesn't block the event loop while it waits.
const RM = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 } as const;

afterEach(async () => {
  session.dispose();
  await fs.promises.rm(root, RM);
  await fs.promises.rm(outside, RM);
});

const sh = (cmd: string) => session.execute(cmd, { timeout: 60_000 });
const posix = (p: string) => p.replace(/\\/g, '/');

/** A shell that records what it is asked to run. */
function spyShell(pwd: string): GuardShell & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    execute: async (command: string) => {
      commands.push(command);
      return { stdout: command === 'pwd -P' ? pwd : '', exitCode: 0 };
    },
  };
}

// Real Git Bash sessions start slowly on a loaded machine (the pre-commit hook
// runs these beside the whole suite), so the 5 s default is too tight.
describe('ShellRootGuard (#196)', { timeout: 30_000 }, () => {
  it('moves the shell back after a command leaves the clone, so the next relative command runs in the clone', async () => {
    const guard = new ShellRootGuard(root);
    const leave = `cd -- '${posix(outside)}'`;
    await sh(leave);
    const note = await guard.afterCommand(session, leave);
    expect(note).toContain('outside the repository');
    expect(note).toContain('moved back to the repository root');
    expect((await sh('ls src')).stdout).toContain('mod.py');
  });

  it('leaves a cd inside the clone alone, as the product does', async () => {
    const guard = new ShellRootGuard(root);
    await sh('cd src');
    expect(await guard.afterCommand(session, 'cd src')).toBe('');
    expect((await sh('ls')).stdout).toContain('mod.py');
  });

  it('treats a sibling directory sharing the root as a prefix as outside', async () => {
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling);
    try {
      const guard = new ShellRootGuard(root);
      const leave = `cd -- '${posix(sibling)}'`;
      await sh(leave);
      expect(await guard.afterCommand(session, leave)).not.toBe('');
    } finally {
      await fs.promises.rm(sibling, RM);
    }
  });

  // The canary check that found this: bash numbers error messages by the
  // session's input line, so one probe sent to the session changed
  // `bash: line 1:` to `line 4:` and diverged three runs that never changed
  // directory.
  it('sends nothing to the session after a command that cannot change directory', async () => {
    const shell = spyShell('/elsewhere');
    const guard = new ShellRootGuard(root, () => '/repo');
    for (const cmd of ['pytest -k test_cd', 'rg -n "def refine(" sympy/', 'python reproduce.py', 'echo abcd']) {
      expect(await guard.afterCommand(shell, cmd)).toBe('');
    }
    expect(shell.commands).toEqual([]);
  });

  it('leaves bash error line numbers as an unguarded session reports them', async () => {
    const guard = new ShellRootGuard(root);
    await sh('ls');
    await guard.afterCommand(session, 'ls');
    const guarded = (await sh('definitely_not_a_command_xyz')).stdout;
    const bare = new ShellSession(root);
    try {
      await bare.execute('ls', { timeout: 60_000 });
      const unguarded = (await bare.execute('definitely_not_a_command_xyz', { timeout: 60_000 })).stdout;
      expect(guarded).toBe(unguarded);
    } finally {
      bare.dispose();
    }
  });

  it('wraps run_command and run_tests, keeps other extra tools, and appends the note to the result', async () => {
    const guard = new ShellRootGuard(root);
    const leave = `cd -- '${posix(outside)}'`;
    const mk = (name: string, run: () => Promise<string>): RegisteredTool =>
      ({ definition: { name }, executor: run }) as unknown as RegisteredTool;
    const runCommand = mk('run_command', async () => {
      await sh(leave);
      return 'ran';
    });
    const gitCommit = mk('git_commit', async () => 'committed');
    const tools = shellGuardTools(
      [runCommand, gitCommit],
      (name) => (name === 'run_tests' ? mk('run_tests', async () => 'tests') : undefined),
      guard,
      () => session,
    );
    expect(tools.map((t) => t.definition.name).sort()).toEqual(['git_commit', 'run_command', 'run_tests']);
    const out = await tools
      .find((t) => t.definition.name === 'run_command')!
      .executor({ command: leave }, undefined as never);
    expect(out.startsWith('ran')).toBe(true);
    expect(out).toContain(returnedNote('').trim().slice(0, 30));
    expect(await tools.find((t) => t.definition.name === 'git_commit')!.executor({}, undefined as never)).toBe(
      'committed',
    );
    expect((await sh('ls src')).stdout).toContain('mod.py');
  });

  it('does nothing when the root cannot be resolved, or the probe times out', async () => {
    const noRoot = new ShellRootGuard(root, () => null);
    const shell = spyShell('/elsewhere');
    expect(await noRoot.afterCommand(shell, 'cd /tmp')).toBe('');
    expect(shell.commands).toEqual([]);
    const slow = new ShellRootGuard(root, () => '/repo');
    const timedOut = { execute: async () => ({ stdout: '', exitCode: 124, timedOut: true }) };
    expect(await slow.afterCommand(timedOut, 'cd /tmp')).toBe('');
  });

  // macOS: the harness clones under os.tmpdir(), /var/folders/..., a symlink to
  // /private/var/... -- the shell's `pwd -P` reports the resolved path while the
  // harness holds the link. (Verified on a Mac on 57b5ffa; a junction makes the
  // same case on Windows, a symlink elsewhere.)
  it('works when the clone root is reached through a symlink', async () => {
    const link = `${root}-link`;
    fs.symlinkSync(root, link, 'junction');
    const linked = new ShellSession(link);
    try {
      const guard = new ShellRootGuard(link);
      await linked.execute('cd src', { timeout: 60_000 });
      expect(await guard.afterCommand(linked, 'cd src')).toBe('');
      const leave = `cd -- '${posix(outside)}'`;
      await linked.execute(leave, { timeout: 60_000 });
      expect(await guard.afterCommand(linked, leave)).toContain('outside the repository');
      expect((await linked.execute('ls src', { timeout: 60_000 })).stdout).toContain('mod.py');
    } finally {
      linked.dispose();
      fs.unlinkSync(link);
    }
  });

  it('resolves the root the way the session spells it', async () => {
    expect(resolveRootWithBash(root)).toBe((await sh('pwd -P')).stdout.trim());
  });
});

describe('mayChangeDirectory', () => {
  it.each([
    ['cd /tmp', true],
    ['ls; cd ..', true],
    ['cd src && pytest', true],
    ['pushd build', true],
    ['popd', true],
    ['source venv/bin/activate', true],
    ['. venv/bin/activate', true],
    ['exec bash', true],
    ['(cd sub && make) || true', true],
    ['pytest -k test_cd', false],
    ['echo abcd', false],
    ['python ./script.py', false],
    ['rg -n "def refine(" sympy/', false],
  ])('%s -> %s', (command, expected) => {
    expect(mayChangeDirectory(command)).toBe(expected);
  });
});
