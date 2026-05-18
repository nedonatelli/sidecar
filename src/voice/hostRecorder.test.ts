import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs');
  return { ...real, unlink: vi.fn((_p: string, cb: () => void) => cb()) };
});

vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...real,
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.alloc(8)),
    unlink: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');

  function makeFakeProc(stdoutLines: string[] = [], stderrLines: string[] = []) {
    const proc = new EventEmitter() as ReturnType<typeof import('child_process').spawn>;
    (proc as unknown as { stdout: typeof EventEmitter.prototype }).stdout = new EventEmitter();
    (proc as unknown as { stderr: typeof EventEmitter.prototype }).stderr = new EventEmitter();
    (proc as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
    (proc as unknown as { exitCode: number | null }).exitCode = null;
    process.nextTick(() => {
      for (const line of stderrLines)
        (proc as unknown as { stderr: typeof EventEmitter.prototype }).stderr.emit('data', Buffer.from(line + '\n'));
      for (const line of stdoutLines)
        (proc as unknown as { stdout: typeof EventEmitter.prototype }).stdout.emit('data', Buffer.from(line + '\n'));
      proc.emit('spawn');
    });
    return proc;
  }

  return {
    execFile: vi.fn((_bin: string, _args: string[], cb: (err: null, stdout: string, stderr: string) => void) =>
      process.nextTick(() => cb(null, '', '')),
    ),
    spawn: vi.fn(() => makeFakeProc([], ['RECORDING'])),
  };
});

vi.mock('os', () => ({
  platform: vi.fn().mockReturnValue('darwin'),
  arch: vi.fn().mockReturnValue('arm64'),
  tmpdir: vi.fn().mockReturnValue('/tmp'),
  homedir: vi.fn().mockReturnValue('/home/user'),
}));

import * as fsp from 'fs/promises';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { isHostRecordingAvailable, startHostRecording } from './hostRecorder.js';

const mockAccess = vi.mocked(fsp.access);
const mockSpawn = vi.mocked(spawn);
const mockExecFile = vi.mocked(execFile);
const mockPlatform = vi.mocked(os.platform);

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.mockReturnValue('darwin');
  mockAccess.mockResolvedValue(undefined); // stamp file exists by default
  vi.mocked(fsp.readFile).mockResolvedValue(Buffer.alloc(8));
  // Default execFile: swiftc compile succeeds, 'which' returns a path
  mockExecFile.mockImplementation(((
    _bin: string,
    _args: string[],
    cb: (err: null, stdout: string, stderr: string) => void,
  ) => process.nextTick(() => cb(null, '/usr/bin/tool', ''))) as never);
});

// ---------------------------------------------------------------------------
// isHostRecordingAvailable
// ---------------------------------------------------------------------------

describe('isHostRecordingAvailable', () => {
  it('returns true on macOS when swiftc is found', async () => {
    expect(await isHostRecordingAvailable()).toBe(true);
  });

  it('returns false on macOS when swiftc is absent', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    expect(await isHostRecordingAvailable()).toBe(false);
  });

  it('returns true on windows unconditionally', async () => {
    mockPlatform.mockReturnValue('win32');
    expect(await isHostRecordingAvailable()).toBe(true);
  });

  it('returns false on unsupported platforms', async () => {
    mockPlatform.mockReturnValue('freebsd' as NodeJS.Platform);
    expect(await isHostRecordingAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startHostRecording — macOS path
// ---------------------------------------------------------------------------

describe('startHostRecording (macOS)', () => {
  it('returns a handle and spawns the recorder binary', async () => {
    const handle = await startHostRecording();
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(handle).toBeDefined();
    handle.dispose();
  });

  it('stop() returns the pcm buffer and cleans up', async () => {
    const pcm = Buffer.alloc(16, 0x42);
    vi.mocked(fsp.readFile).mockResolvedValue(pcm);
    const handle = await startHostRecording();
    const result = await handle.stop();
    expect(result).toEqual(pcm);
    expect(fsp.unlink).toHaveBeenCalled();
  });

  it('stop() is idempotent — second call returns empty buffer', async () => {
    const handle = await startHostRecording();
    await handle.stop();
    const second = await handle.stop();
    expect(second.length).toBe(0);
  });

  it('calls onCompiling when stamp file is absent (first-time compile)', async () => {
    // Stamp file missing → needs compile
    mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
    const onCompiling = vi.fn();
    const handle = await startHostRecording(onCompiling);
    expect(onCompiling).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('skips onCompiling when stamp file exists (cached binary)', async () => {
    // mockAccess resolves (stamp exists) — set by beforeEach
    const onCompiling = vi.fn();
    const handle = await startHostRecording(onCompiling);
    expect(onCompiling).not.toHaveBeenCalled();
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Linux path
// ---------------------------------------------------------------------------

describe('startHostRecording (linux)', () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue('linux');
    // 'which arecord' succeeds, everything else does too
    mockExecFile.mockImplementation(((_bin: string, args: string[], cb: (err: null, stdout: string) => void) => {
      const out = args[0] === 'arecord' ? '/usr/bin/arecord' : '';
      process.nextTick(() => cb(null, out));
    }) as never);
  });

  it('spawns arecord when available', async () => {
    const handle = await startHostRecording();
    expect(mockSpawn).toHaveBeenCalledWith('arecord', expect.arrayContaining(['-f', 'S16_LE', '-r', '16000']));
    handle.dispose();
  });

  it('stop() converts S16_LE to Float32', async () => {
    // 2 S16_LE samples: max positive and min negative
    const s16 = Buffer.alloc(4);
    s16.writeInt16LE(32767, 0);
    s16.writeInt16LE(-32768, 2);
    vi.mocked(fsp.readFile).mockResolvedValue(s16);

    const handle = await startHostRecording();
    const result = await handle.stop();

    const f32 = new Float32Array(result.buffer, result.byteOffset, result.byteLength / 4);
    expect(f32[0]).toBeCloseTo(32767 / 32768, 4);
    expect(f32[1]).toBeCloseTo(-1.0, 4);
  });

  it('throws when neither arecord nor sox is found', async () => {
    mockExecFile.mockImplementation(((_bin: string, _args: string[], cb: (err: Error) => void) =>
      process.nextTick(() => cb(new Error('not found')))) as never);
    await expect(startHostRecording()).rejects.toThrow('alsa-utils');
  });
});

// ---------------------------------------------------------------------------
// s16leToFloat32 — zero samples (via Linux recorder stop)
// ---------------------------------------------------------------------------

describe('s16leToFloat32 — zero samples', () => {
  it('returns empty buffer for empty input', async () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFile.mockImplementation(((_bin: string, args: string[], cb: (err: null, out: string) => void) =>
      process.nextTick(() => cb(null, args[0] === 'arecord' ? '/usr/bin/arecord' : ''))) as never);
    vi.mocked(fsp.readFile).mockResolvedValue(Buffer.alloc(0));
    const handle = await startHostRecording();
    const result = await handle.stop();
    expect(result.length).toBe(0);
  });
});
