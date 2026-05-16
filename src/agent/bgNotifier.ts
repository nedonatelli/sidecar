import type { BackgroundAgentRunInfo } from './backgroundAgent.js';

export interface BgNotifyDeps {
  showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  showErrorMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
}

const VIEW_FOCUS_CMD = 'sidecar.backgroundAgents.focus';
const VIEW_ACTION = 'View Output';

/**
 * Fire a VS Code notification toast when a background agent run finishes.
 *
 * Completed runs get an informational toast; failed runs get an error toast.
 * Both include a "View Output" action that focuses the Background Agents panel.
 * Cancelled runs are silent — the user initiated the cancellation and already
 * knows about it.
 */
export function notifyBgComplete(run: BackgroundAgentRunInfo, deps: BgNotifyDeps): void {
  const label = run.task.length > 50 ? run.task.slice(0, 47) + '…' : run.task;

  if (run.status === 'completed') {
    const calls = run.toolCalls === 1 ? '1 tool call' : `${run.toolCalls} tool calls`;
    deps.showInformationMessage(`Background task completed: "${label}" (${calls})`, VIEW_ACTION).then((choice) => {
      if (choice === VIEW_ACTION) {
        deps.executeCommand(VIEW_FOCUS_CMD);
      }
    });
  } else if (run.status === 'failed') {
    const errSuffix = run.error ? ` — ${run.error.slice(0, 80)}` : '';
    deps.showErrorMessage(`Background task failed: "${label}"${errSuffix}`, VIEW_ACTION).then((choice) => {
      if (choice === VIEW_ACTION) {
        deps.executeCommand(VIEW_FOCUS_CMD);
      }
    });
  }
  // 'cancelled' is intentionally silent — user initiated it.
}
