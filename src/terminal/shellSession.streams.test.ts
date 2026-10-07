import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { ShellSession, resolvePosixShell } from './shellSession.js';

// #114: stderr that escaped the 2>&1 redirect was streamed to the chat twice.
describe('ShellSession streams', () => {
  it('streams stderr output once', async () => {
    const session = new ShellSession('.');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let written = '';
    const fake = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: { write: (s: string) => ((written += s), true) },
      exitCode: null,
      pid: 1,
      kill: () => true,
    });
    const internals = session as unknown as { proc: unknown; ready: Promise<void> };
    internals.proc = fake;
    internals.ready = Promise.resolve();

    const chunks: string[] = [];
    const run = session.execute('noisy', { onOutput: (c) => chunks.push(c) });
    await new Promise((r) => setTimeout(r, 10));
    const sentinel = /(SIDECAR[0-9A-F]{16})_/.exec(written)?.[1];
    expect(sentinel).toBeTruthy();
    stderr.write('warning: escaped stderr\n');
    await new Promise((r) => setTimeout(r, 10));
    stdout.write(`${sentinel}_0_END\n`);
    const result = await run;

    expect(result.stdout).toContain('warning: escaped stderr');
    expect(chunks.join('').split('warning: escaped stderr').length - 1).toBe(1);
  });
});

// #114: a fish (or dash, nushell) $SHELL got bash flags and syntax, and every
// command hung to the idle timeout.
describe('resolvePosixShell', () => {
  it('keeps a bash or zsh $SHELL', () => {
    expect(resolvePosixShell('/usr/local/bin/bash')).toBe('/usr/local/bin/bash');
    expect(resolvePosixShell('/bin/zsh')).toBe('/bin/zsh');
  });

  it('does not use fish, dash or an unset $SHELL', () => {
    for (const sh of ['/usr/bin/fish', '/bin/dash', '/usr/bin/nu', undefined]) {
      expect(resolvePosixShell(sh)).toMatch(/\/(bash|zsh|sh)$/);
      expect(resolvePosixShell(sh)).not.toMatch(/fish|dash|nu$/);
    }
  });
});
