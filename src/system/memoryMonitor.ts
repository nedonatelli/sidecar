/**
 * System memory monitor — structured RAM + VRAM readings and pressure checks.
 *
 * Three consumers:
 *   1. Pre-flight gate: checkMemoryPreflight() blocks/warns before model loads.
 *   2. Background monitor: MemoryPressureMonitor polls every 30 s and fires
 *      VS Code notifications if the machine is running dangerously low.
 *   3. Status bar: getSystemMemory() supplies the RAM%/VRAM% readout.
 *
 * RAM reads use os.freemem() — always available, zero cost.
 * VRAM reads spawn nvidia-smi / rocm-smi — only on demand (status bar refresh).
 */

import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { window, commands, type Disposable } from 'vscode';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VramInfo {
  label: string;
  totalMib: number;
  usedMib: number;
  freeMib: number;
  usedPct: number;
}

export interface SystemMemory {
  ram: {
    totalGib: number;
    freeGib: number;
    usedGib: number;
    usedPct: number;
  };
  /** Empty when no GPU is present or the probe fails. */
  vram: VramInfo[];
}

export type MemoryPressure = 'ok' | 'low' | 'critical';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Block the operation — less than this much free RAM is genuinely dangerous. */
export const RAM_CRITICAL_GIB = 1.0;

/** Warn the user — less than this much free RAM risks OOM and system freeze. */
export const RAM_LOW_GIB = 2.0;

/** Warn before GPU-bound model loads when VRAM is this tight. */
export const VRAM_LOW_MIB = 512;

// ---------------------------------------------------------------------------
// VRAM probes — return [] on any failure
// ---------------------------------------------------------------------------

async function nvidiaSmiMemory(): Promise<VramInfo[]> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits',
      { timeout: 4_000 },
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, total, used, free] = line.split(',').map((s) => s.trim());
        const totalMib = parseInt(total ?? '0', 10) || 0;
        const usedMib = parseInt(used ?? '0', 10) || 0;
        const freeMib = parseInt(free ?? '0', 10) || 0;
        return {
          label: name ?? 'NVIDIA GPU',
          totalMib,
          usedMib,
          freeMib,
          usedPct: totalMib > 0 ? Math.round((usedMib / totalMib) * 100) : 0,
        };
      });
  } catch {
    return [];
  }
}

async function rocmSmiMemory(): Promise<VramInfo[]> {
  try {
    const { stdout } = await execAsync('rocm-smi --showmeminfo vram --csv', { timeout: 4_000 });
    return stdout
      .trim()
      .split('\n')
      .filter((l) => /^\d/.test(l))
      .map((line) => {
        const parts = line.split(',').map((s) => s.trim());
        const totalBytes = parseInt(parts[1] ?? '0', 10);
        const usedBytes = parseInt(parts[2] ?? '0', 10);
        const totalMib = Math.round(totalBytes / 1024 ** 2);
        const usedMib = Math.round(usedBytes / 1024 ** 2);
        const freeMib = totalMib - usedMib;
        return {
          label: `AMD GPU ${parts[0] ?? ''}`.trim(),
          totalMib,
          usedMib,
          freeMib,
          usedPct: totalMib > 0 ? Math.round((usedMib / totalMib) * 100) : 0,
        };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read current RAM and VRAM (if any GPU probe succeeds).
 * Safe to call on any platform; returns empty vram[] on desktop systems
 * without a CUDA/ROCm-capable GPU.
 */
export async function getSystemMemory(): Promise<SystemMemory> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const gib = 1024 ** 3;

  const ram = {
    totalGib: totalBytes / gib,
    freeGib: freeBytes / gib,
    usedGib: usedBytes / gib,
    usedPct: Math.round((usedBytes / totalBytes) * 100),
  };

  const [nvidia, amd] = await Promise.all([nvidiaSmiMemory(), rocmSmiMemory()]);
  const vram = nvidia.length > 0 ? nvidia : amd;

  return { ram, vram };
}

/** Classify the current memory state into pressure tiers. */
export function assessPressure(mem: SystemMemory): { ram: MemoryPressure; vram: MemoryPressure } {
  const ram: MemoryPressure =
    mem.ram.freeGib < RAM_CRITICAL_GIB ? 'critical' : mem.ram.freeGib < RAM_LOW_GIB ? 'low' : 'ok';

  const vram: MemoryPressure =
    mem.vram.length === 0 ? 'ok' : mem.vram.every((v) => v.freeMib < VRAM_LOW_MIB) ? 'low' : 'ok';

  return { ram, vram };
}

/**
 * Pre-flight check for memory-intensive operations (model load, HF import).
 *
 * Returns `true` when it is safe to proceed.
 * Returns `false` when the operation was blocked (critical pressure) or
 * the user chose to cancel (low-pressure warning dialog).
 *
 * `label` is inserted into the warning copy: e.g. "load this model into GPU".
 */
export async function checkMemoryPreflight(label: string): Promise<boolean> {
  let mem: SystemMemory;
  try {
    // RAM read is instant; skip the GPU probe for speed.
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const gib = 1024 ** 3;
    mem = {
      ram: {
        totalGib: totalBytes / gib,
        freeGib: freeBytes / gib,
        usedGib: (totalBytes - freeBytes) / gib,
        usedPct: Math.round(((totalBytes - freeBytes) / totalBytes) * 100),
      },
      vram: [],
    };
  } catch {
    return true; // if we can't read memory at all, don't block
  }

  const { ram } = assessPressure(mem);
  const freeStr = `${mem.ram.freeGib.toFixed(1)} GiB`;

  if (ram === 'critical') {
    await window.showErrorMessage(
      `Cannot ${label}: only ${freeStr} free RAM (need at least ${RAM_CRITICAL_GIB} GiB). ` +
        `Close some applications and try again.`,
    );
    return false;
  }

  if (ram === 'low') {
    const choice = await window.showWarningMessage(
      `Low memory: only ${freeStr} free RAM. Attempting to ${label} may cause slowdowns or an out-of-memory crash.`,
      'Proceed Anyway',
      'Cancel',
    );
    return choice === 'Proceed Anyway';
  }

  return true;
}

// ---------------------------------------------------------------------------
// Background pressure monitor
// ---------------------------------------------------------------------------

/**
 * Polls RAM every 30 s and fires VS Code notifications when the system is
 * under significant memory pressure. Intended to run for the lifetime of
 * the extension so the user is warned even when the agent is idle.
 *
 * Uses only os.freemem() — no shell processes, zero overhead.
 */
export class MemoryPressureMonitor implements Disposable {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveLow = 0;
  private lastNotifiedAt = 0;

  private static readonly POLL_MS = 30_000;
  private static readonly RENOTIFY_MS = 5 * 60_000;
  private static readonly CONSECUTIVE_BEFORE_ALERT = 2;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), MemoryPressureMonitor.POLL_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.consecutiveLow = 0;
  }

  private async poll(): Promise<void> {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const freeGib = freeBytes / 1024 ** 3;

    const pressure: MemoryPressure = freeGib < RAM_CRITICAL_GIB ? 'critical' : freeGib < RAM_LOW_GIB ? 'low' : 'ok';

    if (pressure === 'ok') {
      this.consecutiveLow = 0;
      return;
    }

    this.consecutiveLow++;
    if (this.consecutiveLow < MemoryPressureMonitor.CONSECUTIVE_BEFORE_ALERT) return;

    const now = Date.now();
    if (now - this.lastNotifiedAt < MemoryPressureMonitor.RENOTIFY_MS) return;
    this.lastNotifiedAt = now;

    const pct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
    const freeStr = `${freeGib.toFixed(1)} GiB`;

    if (pressure === 'critical') {
      const choice = await window.showErrorMessage(
        `System memory critically low: only ${freeStr} free (${pct}% used). The agent or model may crash. Stop the agent to free memory.`,
        'Stop Agent',
        'Dismiss',
      );
      if (choice === 'Stop Agent') {
        await commands.executeCommand('sidecar.abort');
      }
    } else {
      void window.showWarningMessage(
        `System memory running low: only ${freeStr} free (${pct}% used). Consider closing unused applications.`,
      );
    }
  }
}
