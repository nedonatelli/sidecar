import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// spawnHook drives a real child process with activity-adaptive timeouts and
// output truncation. We mock child_process + the process registry and use fake
// timers so the timing/truncation logic is exercised deterministically (real
// subprocess timing would be flaky and platform-dependent).

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

const disposeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./processLifecycle.js', () => ({
  ManagedChildProcess: vi.fn(function () {
    return { dispose: disposeMock };
  }),
  getProcessRegistry: vi.fn(() => ({})),
}));

import { runSpawnedHook } from './spawnHook.js';

type FakeProc = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function makeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function run(over: Partial<Parameters<typeof runSpawnedHook>[0]> = {}) {
  return runSpawnedHook({ command: 'echo hi', env: {}, label: 'test', ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runSpawnedHook — output + exit', () => {
  it('assembles stdout/stderr and resolves with the exit code', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = run();
    proc.stdout.emit('data', Buffer.from('hello '));
    proc.stdout.emit('data', Buffer.from('world'));
    proc.stderr.emit('data', Buffer.from('a warning'));
    proc.emit('exit', 0, null);
    const r = await p;
    expect(r.stdout).toBe('hello world');
    expect(r.stderr).toBe('a warning');
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.outputTruncated).toBe(false);
  });

  it('propagates a non-zero exit code and a terminating signal', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p1 = run();
    proc.emit('exit', 3, null);
    expect((await p1).exitCode).toBe(3);

    const proc2 = makeProc();
    spawnMock.mockReturnValue(proc2);
    const p2 = run();
    proc2.emit('exit', null, 'SIGTERM');
    const r2 = await p2;
    expect(r2.signal).toBe('SIGTERM');
    expect(r2.exitCode).toBeNull();
  });

  it('resolves with a null exit code when the process errors', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = run();
    proc.emit('error', new Error('ENOENT'));
    const r = await p;
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it('truncates output past maxOutputBytes with an elision marker', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = run({ maxOutputBytes: 10 });
    proc.stdout.emit('data', Buffer.from('X'.repeat(40)));
    proc.stdout.emit('data', Buffer.from('dropped after overflow'));
    proc.emit('exit', 0, null);
    const r = await p;
    expect(r.outputTruncated).toBe(true);
    expect(r.stdout).toMatch(/bytes elided\]/);
    expect(r.stdout.length).toBeLessThan(40);
  });
});

describe('runSpawnedHook — timeouts', () => {
  it('kills the process when no output arrives within the initial budget', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = run({ initialTimeoutMs: 100 });

    vi.advanceTimersByTime(101); // no data → initial-budget timer fires
    expect(disposeMock).toHaveBeenCalledTimes(1);

    proc.emit('exit', null, 'SIGTERM'); // dispose kills → exit fires
    const r = await p;
    expect(r.timedOut).toBe(true);
  });

  it('resets the activity timer on output, then times out after the quiet window', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = run({ initialTimeoutMs: 100, activityResetMs: 100 });

    vi.advanceTimersByTime(80);
    proc.stdout.emit('data', Buffer.from('tick')); // resets the activity timer
    vi.advanceTimersByTime(80); // 80 < 100 since reset — not yet timed out
    expect(disposeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30); // now past the 100ms quiet window
    expect(disposeMock).toHaveBeenCalledTimes(1);

    proc.emit('exit', null, 'SIGKILL');
    expect((await p).timedOut).toBe(true);
  });

  it('enforces the hard cap regardless of ongoing activity', async () => {
    const proc = makeProc();
    spawnMock.mockReturnValue(proc);
    const p = run({ activityResetMs: 10_000, hardCapMs: 200 });

    // Keep producing output so the activity timer never fires...
    vi.advanceTimersByTime(150);
    proc.stdout.emit('data', Buffer.from('still going'));
    vi.advanceTimersByTime(60); // total 210 > hardCap 200
    expect(disposeMock).toHaveBeenCalledTimes(1);

    proc.emit('exit', null, 'SIGTERM');
    expect((await p).timedOut).toBe(true);
  });
});
