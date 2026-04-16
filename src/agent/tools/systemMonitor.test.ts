import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the `os` module at the factory level — `vi.spyOn(os, …)` fails under
// ESM because the module namespace is non-configurable. Every property we
// read in the executor has to be declared here so the factory returns a
// mutable test double.
// ---------------------------------------------------------------------------
const osState = {
  loadavg: [0.5, 0.4, 0.3] as number[],
  cpus: [
    { model: 'Test CPU', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'Test CPU', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
  ],
  totalmem: 16 * 1024 ** 3, // 16 GiB
  freemem: 8 * 1024 ** 3, //  8 GiB free
  platform: 'linux' as NodeJS.Platform,
  release: '6.5.0',
};

vi.mock('os', () => ({
  loadavg: () => osState.loadavg,
  cpus: () => osState.cpus,
  totalmem: () => osState.totalmem,
  freemem: () => osState.freemem,
  platform: () => osState.platform,
  release: () => osState.release,
}));

// We mock child_process.exec so the tests never shell out to nvidia-smi etc.
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'child_process';
import { systemMonitor } from './systemMonitor.js';

// Promisify wraps the mock, so we need to make exec call its callback.
// The `exec(cmd, opts, cb)` and `exec(cmd, cb)` overloads mean `opts` can
// actually be the callback when the caller omits options.
function mockExec(stdout: string, stderr = '', exitCode = 0) {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (exitCode !== 0) {
        callback?.(new Error('command failed'), { stdout: '', stderr });
      } else {
        callback?.(null, { stdout, stderr });
      }
    },
  );
}

function mockExecFail() {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback?.(new Error('not found'), { stdout: '', stderr: 'not found' });
    },
  );
}

describe('systemMonitor', () => {
  beforeEach(() => {
    // Reset the mocked os state to defaults between tests.
    osState.loadavg = [0.5, 0.4, 0.3];
    osState.totalmem = 16 * 1024 ** 3;
    osState.freemem = 8 * 1024 ** 3;
    osState.platform = 'linux';
    osState.release = '6.5.0';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes CPU load averages and model', async () => {
    mockExecFail(); // no GPU
    const result = await systemMonitor({});
    expect(result).toContain('Test CPU');
    expect(result).toContain('0.50');
    expect(result).toContain('2 logical cores');
  });

  it('includes RAM total, used, and free', async () => {
    mockExecFail();
    const result = await systemMonitor({});
    expect(result).toContain('16.0 GiB');
    expect(result).toContain('8.0 GiB');
    expect(result).toContain('50%');
  });

  it('parses nvidia-smi output and reports VRAM', async () => {
    // nvidia-smi returns CSV: name, total MiB, used MiB, free MiB, util%
    mockExec('NVIDIA GeForce RTX 4090, 24576, 8192, 16384, 42');
    const result = await systemMonitor({ include_gpu: true });
    expect(result).toContain('NVIDIA');
    expect(result).toContain('RTX 4090');
    expect(result).toContain('24.0 GiB');
    expect(result).toContain('8.0 GiB');
  });

  it('falls back to "no GPU detected" when all probes fail', async () => {
    mockExecFail();
    const result = await systemMonitor({ include_gpu: true });
    expect(result).toContain('no supported GPU detected');
  });

  it('skips GPU section when include_gpu is false', async () => {
    const execMock = exec as unknown as ReturnType<typeof vi.fn>;
    execMock.mockClear();
    const result = await systemMonitor({ include_gpu: false });
    // GPU probe commands should never be spawned
    expect(result).not.toContain('GPU');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('includes platform info', async () => {
    mockExecFail();
    const result = await systemMonitor({});
    expect(result).toContain('linux');
    expect(result).toContain('6.5.0');
  });
});
