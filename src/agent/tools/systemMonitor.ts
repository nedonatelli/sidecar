/**
 * system_monitor tool — reports CPU load, RAM usage, and VRAM usage.
 *
 * Designed to be read-only and cross-platform:
 *   - macOS  : vm_stat + sysctl + top (CPU), nvidia-smi / metal (VRAM)
 *   - Linux  : /proc/meminfo + /proc/loadavg, nvidia-smi / rocm-smi (VRAM)
 *   - Windows: wmic / PowerShell (best-effort)
 *
 * The agent uses this before kicking off a heavy compile, model
 * download, or parallel sub-agent run so it can decide whether to
 * throttle or warn the user about resource pressure.
 *
 * requiresApproval: false — purely observational, no side effects.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Tool definition (schema exposed to the LLM)
// ---------------------------------------------------------------------------

export const systemMonitorDef: ToolDefinition = {
  name: 'system_monitor',
  description:
    'Report current system resource usage: CPU load, RAM (total / used / free), and VRAM / GPU memory ' +
    'when a supported GPU is present (NVIDIA via nvidia-smi, AMD via rocm-smi, Apple Silicon via powermetrics). ' +
    'Use before starting a heavy operation (large build, model download, parallel sub-agents) to check whether ' +
    'the machine has headroom, or when the user asks about system load. ' +
    'Returns a structured text summary — no side effects, no files written. ' +
    'Example: `system_monitor()` or `system_monitor(include_gpu=true)`.',
  input_schema: {
    type: 'object',
    properties: {
      include_gpu: {
        type: 'boolean',
        description:
          'Whether to probe GPU / VRAM metrics. Default true. ' +
          'Set false to skip the GPU probe when you only need CPU/RAM and want a faster response.',
      },
    },
    required: [],
  },
};

// ---------------------------------------------------------------------------
// Helpers — each returns a human-readable string or null on failure
// ---------------------------------------------------------------------------

/** Bytes → human-readable string (GiB preferred, MiB fallback). */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${bytes} B`;
}

/** CPU load averages from os.loadavg() — available on all platforms. */
function cpuSection(): string {
  const [l1, l5, l15] = os.loadavg();
  const cpus = os.cpus().length;
  const model = os.cpus()[0]?.model?.trim() ?? 'unknown';
  const pct1 = ((l1 / cpus) * 100).toFixed(0);
  return [
    `CPU: ${model} (${cpus} logical cores)`,
    `  Load avg (1m / 5m / 15m): ${l1.toFixed(2)} / ${l5.toFixed(2)} / ${l15.toFixed(2)}  (${pct1}% utilisation over last 1 min)`,
  ].join('\n');
}

/** RAM from os.totalmem / os.freemem — cross-platform. */
function ramSection(): string {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const pct = ((used / total) * 100).toFixed(0);
  return [
    `RAM:`,
    `  Total : ${fmtBytes(total)}`,
    `  Used  : ${fmtBytes(used)}  (${pct}%)`,
    `  Free  : ${fmtBytes(free)}`,
  ].join('\n');
}

/** NVIDIA VRAM via nvidia-smi. Returns null if not available. */
async function nvidiaSmi(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits',
      { timeout: 5000 },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const rows = lines.map((line, i) => {
      const [name, total, used, free, util] = line.split(',').map((s) => s.trim());
      const totalMiB = parseInt(total, 10);
      const usedMiB = parseInt(used, 10);
      const freeMiB = parseInt(free, 10);
      return [
        `  GPU ${i}: ${name}`,
        `    VRAM  total : ${fmtBytes(totalMiB * 1024 ** 2)}`,
        `    VRAM  used  : ${fmtBytes(usedMiB * 1024 ** 2)}  (${util}% GPU util)`,
        `    VRAM  free  : ${fmtBytes(freeMiB * 1024 ** 2)}`,
      ].join('\n');
    });
    return `GPU (NVIDIA):\n${rows.join('\n')}`;
  } catch {
    return null;
  }
}

/** AMD VRAM via rocm-smi. Returns null if not available. */
async function rocmSmi(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('rocm-smi --showmeminfo vram --csv', { timeout: 5000 });
    // rocm-smi CSV: GPU,VRAM Total Memory (B),VRAM Total Used Memory (B)
    const lines = stdout
      .trim()
      .split('\n')
      .filter((l) => /^\d/.test(l));
    if (!lines.length) return null;
    const rows = lines.map((line) => {
      const parts = line.split(',').map((s) => s.trim());
      const gpu = parts[0];
      const total = parseInt(parts[1] ?? '0', 10);
      const used = parseInt(parts[2] ?? '0', 10);
      const free = total - used;
      return [
        `  GPU ${gpu} (AMD)`,
        `    VRAM  total : ${fmtBytes(total)}`,
        `    VRAM  used  : ${fmtBytes(used)}`,
        `    VRAM  free  : ${fmtBytes(free)}`,
      ].join('\n');
    });
    return `GPU (AMD / ROCm):\n${rows.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Apple Silicon unified memory via powermetrics (requires sudo) or
 * a best-effort fallback via `system_profiler SPDisplaysDataType`.
 * Returns null if neither is available.
 */
async function appleSiliconGpu(): Promise<string | null> {
  if (os.platform() !== 'darwin') return null;

  // system_profiler is always present on macOS and doesn't need sudo.
  try {
    const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json', { timeout: 8000 });
    const data = JSON.parse(stdout) as {
      SPDisplaysDataType?: Array<{ sppci_model?: string; _spdisplays_vram?: string; spdisplays_vram?: string }>;
    };
    const gpus = data.SPDisplaysDataType ?? [];
    if (!gpus.length) return null;
    const rows = gpus.map((g) => {
      const name = g.sppci_model ?? 'Apple GPU';
      // Unified memory: reported as e.g. "16 GB" or absent for discrete
      const vram = g._spdisplays_vram ?? g.spdisplays_vram ?? 'shared (unified memory)';
      return `  ${name}  —  ${vram}`;
    });
    return `GPU (Apple):\n${rows.join('\n')}\n  Note: Apple Silicon uses unified memory; VRAM is a dynamic slice of system RAM.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function systemMonitor(input: Record<string, unknown>): Promise<string> {
  const includeGpu = input.include_gpu !== false; // default true

  const sections: string[] = [];

  sections.push(cpuSection());
  sections.push(ramSection());

  if (includeGpu) {
    // Try GPU probes in parallel; take the first that succeeds.
    const [nvidia, amd, apple] = await Promise.all([nvidiaSmi(), rocmSmi(), appleSiliconGpu()]);
    const gpuSection = nvidia ?? amd ?? apple;
    if (gpuSection) {
      sections.push(gpuSection);
    } else {
      sections.push(
        'GPU: no supported GPU detected (nvidia-smi, rocm-smi, and system_profiler all unavailable or returned no data)',
      );
    }
  }

  sections.push(`Platform: ${os.platform()} ${os.release()}  |  Node ${process.version}`);

  return sections.join('\n\n');
}

export const systemMonitorTools: RegisteredTool[] = [
  { definition: systemMonitorDef, executor: systemMonitor, requiresApproval: false },
];
