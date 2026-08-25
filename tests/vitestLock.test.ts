import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dir: string;

const load = async () => {
  process.env.SIDECAR_VITEST_LOCK_DIR = dir;
  vi.resetModules();
  return import('./vitestLock.js');
};

const holder = (kind: 'eval' | 'unit', pid: number, command = 'run') =>
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, kind, startedAt: new Date().toISOString(), command }),
  );

// The parent process is alive by construction; `process.pid - 1` only usually is.
const LIVE_PID = process.ppid;

// Above the max pid on Linux and macOS, so it can never be running.
const DEAD_PID = 4_194_304;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-lock-'));
});

afterEach(() => {
  delete process.env.SIDECAR_VITEST_LOCK_DIR;
  delete process.env.SIDECAR_VITEST_KIND;
  delete process.env.SIDECAR_ALLOW_CONCURRENT_VITEST;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vitest lock', () => {
  it('registers on setup and releases on teardown', async () => {
    const lock = await load();
    await lock.setup();
    expect(fs.readdirSync(dir)).toEqual([`${process.pid}.json`]);
    await lock.teardown();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('allows a unit run alongside another unit run', async () => {
    // The pre-commit hook runs two vitest instances at once by design.
    holder('unit', LIVE_PID);
    const lock = await load();
    await expect(lock.setup()).resolves.toBeUndefined();
  });

  it('refuses a unit run while an eval sweep is live', async () => {
    holder('eval', LIVE_PID, 'vitest run --config vitest.eval.config.ts');
    const lock = await load();
    await expect(lock.setup()).rejects.toThrow(/an eval sweep is live/);
  });

  it('refuses an eval sweep while any other run is live', async () => {
    holder('unit', LIVE_PID);
    process.env.SIDECAR_VITEST_KIND = 'eval';
    const lock = await load();
    await expect(lock.setup()).rejects.toThrow(/Refusing to start an eval sweep/);
  });

  it('releases its own registration when it refuses', async () => {
    holder('eval', LIVE_PID);
    const lock = await load();
    await expect(lock.setup()).rejects.toThrow();
    // A refusal that left its own file behind would block every later run.
    expect(fs.existsSync(path.join(dir, `${process.pid}.json`))).toBe(false);
  });

  it('does not treat a dead holder as live', async () => {
    holder('eval', DEAD_PID);
    const lock = await load();
    await expect(lock.setup()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, `${DEAD_PID}.json`))).toBe(false);
  });

  it('sweeps a corrupt entry rather than blocking every later run', async () => {
    fs.writeFileSync(path.join(dir, '99999.json'), 'not json');
    const lock = await load();
    await expect(lock.setup()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, '99999.json'))).toBe(false);
  });

  it('names the blocking run so it can be waited on or killed', async () => {
    holder('eval', LIVE_PID, 'vitest run --config vitest.eval.config.ts');
    const lock = await load();
    await expect(lock.setup()).rejects.toThrow(new RegExp(`eval pid ${LIVE_PID}`));
  });

  it('is a no-op when explicitly overridden', async () => {
    process.env.SIDECAR_ALLOW_CONCURRENT_VITEST = '1';
    holder('eval', LIVE_PID);
    const lock = await load();
    await expect(lock.setup()).resolves.toBeUndefined();
  });
});
