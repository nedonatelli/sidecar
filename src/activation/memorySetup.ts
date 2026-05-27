import { StatusBarAlignment, ThemeColor, window, commands, type ExtensionContext } from 'vscode';
import { getSystemMemory, MemoryPressureMonitor } from '../system/memoryMonitor.js';

/**
 * Initialise the memory subsystem:
 *   - A right-aligned status bar item showing live RAM% (and VRAM% when a
 *     supported GPU is present). Updates every 60 s and on first activation.
 *   - A background MemoryPressureMonitor that fires VS Code notifications
 *     when free RAM drops dangerously low.
 */
export function initMemorySetup(context: ExtensionContext): void {
  const memBar = window.createStatusBarItem(StatusBarAlignment.Right, 99);

  async function refresh(): Promise<void> {
    try {
      const mem = await getSystemMemory();

      let text = `$(dashboard) RAM ${mem.ram.usedPct}%`;
      let tooltip = `RAM: ${mem.ram.freeGib.toFixed(1)} GiB free / ${mem.ram.totalGib.toFixed(1)} GiB total`;

      if (mem.vram.length > 0) {
        const avgGpuPct = Math.round(mem.vram.reduce((s, v) => s + v.usedPct, 0) / mem.vram.length);
        text += ` · GPU ${avgGpuPct}%`;
        tooltip += '\n' + mem.vram.map((v) => `${v.label}: ${v.freeMib} MiB free`).join('\n');
      }

      memBar.text = text;
      memBar.tooltip = tooltip;
      memBar.command = 'sidecar.memory.refresh';
      memBar.color =
        mem.ram.freeGib < 1.0
          ? new ThemeColor('statusBarItem.errorForeground')
          : mem.ram.freeGib < 2.0
            ? new ThemeColor('statusBarItem.warningForeground')
            : undefined;
      memBar.show();
    } catch {
      memBar.hide();
    }
  }

  context.subscriptions.push(
    memBar,
    commands.registerCommand('sidecar.memory.refresh', () => void refresh()),
  );

  // Initial read, then every 60 s.
  void refresh();
  const refreshTimer = setInterval(() => void refresh(), 60_000);

  // Background pressure monitor polls every 30 s via os.freemem() only.
  const monitor = new MemoryPressureMonitor();
  monitor.start();

  context.subscriptions.push(monitor, { dispose: () => clearInterval(refreshTimer) });
}
