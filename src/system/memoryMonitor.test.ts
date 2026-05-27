import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const GiB = 1024 ** 3;
let mockTotal = 16 * GiB;
let mockFree = 8 * GiB;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    totalmem: () => mockTotal,
    freemem: () => mockFree,
    loadavg: () => [0, 0, 0],
    cpus: () => actual.cpus(),
  };
});

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
}));

// Prevent real nvidia-smi / rocm-smi calls in CI.
vi.mock('child_process', () => ({
  exec: vi.fn(
    (_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      cb(new Error('not found'), { stdout: '', stderr: '' });
    },
  ),
}));

import { getSystemMemory, assessPressure, checkMemoryPreflight, MemoryPressureMonitor } from './memoryMonitor.js';
import { window } from 'vscode';

function stubOsMemory(totalGib: number, freeGib: number) {
  mockTotal = totalGib * GiB;
  mockFree = freeGib * GiB;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('getSystemMemory', () => {
  it('returns correct RAM values from os.totalmem / os.freemem', async () => {
    stubOsMemory(16, 8);
    const mem = await getSystemMemory();
    expect(mem.ram.totalGib).toBeCloseTo(16);
    expect(mem.ram.freeGib).toBeCloseTo(8);
    expect(mem.ram.usedGib).toBeCloseTo(8);
    expect(mem.ram.usedPct).toBe(50);
  });

  it('returns empty vram[] when GPU probes fail', async () => {
    stubOsMemory(16, 8);
    const mem = await getSystemMemory();
    expect(mem.vram).toEqual([]);
  });
});

describe('assessPressure', () => {
  function makeRam(freeGib: number) {
    const totalGib = 16;
    const usedGib = totalGib - freeGib;
    return { totalGib, freeGib, usedGib, usedPct: Math.round((usedGib / totalGib) * 100) };
  }

  it('ok when free RAM is above the low threshold', () => {
    const result = assessPressure({ ram: makeRam(4), vram: [] });
    expect(result.ram).toBe('ok');
  });

  it('low when free RAM is below RAM_LOW_GIB but above RAM_CRITICAL_GIB', () => {
    const result = assessPressure({ ram: makeRam(1.5), vram: [] });
    expect(result.ram).toBe('low');
  });

  it('critical when free RAM is below RAM_CRITICAL_GIB', () => {
    const result = assessPressure({ ram: makeRam(0.5), vram: [] });
    expect(result.ram).toBe('critical');
  });

  it('vram ok when no GPU data', () => {
    expect(assessPressure({ ram: makeRam(4), vram: [] }).vram).toBe('ok');
  });

  it('vram low when all GPUs below VRAM_LOW_MIB free', () => {
    const result = assessPressure({
      ram: makeRam(4),
      vram: [{ label: 'Test GPU', totalMib: 8192, usedMib: 8000, freeMib: 192, usedPct: 97 }],
    });
    expect(result.vram).toBe('low');
  });

  it('vram ok when at least one GPU has sufficient free VRAM', () => {
    const result = assessPressure({
      ram: makeRam(4),
      vram: [{ label: 'Test GPU', totalMib: 8192, usedMib: 4096, freeMib: 4096, usedPct: 50 }],
    });
    expect(result.vram).toBe('ok');
  });
});

describe('checkMemoryPreflight', () => {
  it('returns true without showing any dialog when RAM is healthy', async () => {
    stubOsMemory(16, 8);
    const ok = await checkMemoryPreflight('load test-model');
    expect(ok).toBe(true);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('returns false and shows an error when RAM is critically low', async () => {
    stubOsMemory(16, 0.5);
    vi.mocked(window.showErrorMessage).mockResolvedValue(undefined);
    const ok = await checkMemoryPreflight('load test-model');
    expect(ok).toBe(false);
    expect(window.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('returns true when RAM is low and user chooses Proceed Anyway', async () => {
    stubOsMemory(16, 1.5);
    vi.mocked(window.showWarningMessage).mockResolvedValue('Proceed Anyway' as never);
    const ok = await checkMemoryPreflight('load test-model');
    expect(ok).toBe(true);
  });

  it('returns false when RAM is low and user cancels', async () => {
    stubOsMemory(16, 1.5);
    vi.mocked(window.showWarningMessage).mockResolvedValue('Cancel' as never);
    const ok = await checkMemoryPreflight('load test-model');
    expect(ok).toBe(false);
  });
});

describe('MemoryPressureMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not notify when memory is healthy', async () => {
    stubOsMemory(16, 8);
    const monitor = new MemoryPressureMonitor();
    monitor.start();
    // Advance past two consecutive poll intervals
    await vi.advanceTimersByTimeAsync(65_000);
    monitor.dispose();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('notifies after two consecutive low-memory polls', async () => {
    stubOsMemory(16, 1.5); // low but not critical
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    const monitor = new MemoryPressureMonitor();
    monitor.start();
    await vi.advanceTimersByTimeAsync(65_000); // 2 × 30 s polls
    monitor.dispose();
    expect(window.showWarningMessage).toHaveBeenCalledOnce();
  });

  it('does not notify twice within the re-notify cooldown', async () => {
    stubOsMemory(16, 1.5);
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    const monitor = new MemoryPressureMonitor();
    monitor.start();
    await vi.advanceTimersByTimeAsync(65_000); // triggers first notification
    await vi.advanceTimersByTimeAsync(65_000); // still within 5 min cooldown
    monitor.dispose();
    expect(window.showWarningMessage).toHaveBeenCalledOnce();
  });

  it('dispose stops the polling timer', async () => {
    stubOsMemory(16, 1.5);
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    const monitor = new MemoryPressureMonitor();
    monitor.start();
    monitor.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });
});
