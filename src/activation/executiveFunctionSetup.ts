import { window, commands, type ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { PlanStore } from '../agent/plans/planStore.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { ChatViewProvider } from '../webview/chatView.js';

/**
 * On activation: check for an in-progress agent checkpoint and prompt
 * the user to resume or discard it.
 *
 * Only runs when sidecar.executiveFunction.enabled is true. The notification
 * is shown asynchronously after a short delay so it doesn't race with
 * VS Code's own startup UI.
 */
export function initExecutiveFunctionSetup(
  context: ExtensionContext,
  sidecarDir: SidecarDir,
  getChatProvider: () => ChatViewProvider | undefined,
): void {
  if (!getConfig().executiveFunctionEnabled) return;

  const planStore = new PlanStore(sidecarDir);

  context.subscriptions.push(
    commands.registerCommand('sidecar.executiveFunction.resume', async () => {
      const checkpoint = await planStore.load();
      if (!checkpoint) {
        window.showInformationMessage('SideCar: No saved task to resume.');
        return;
      }
      const provider = getChatProvider();
      if (!provider) {
        window.showWarningMessage('SideCar: Chat panel is not ready. Open it first.');
        return;
      }
      await planStore.clear();
      provider.resumeFromCheckpoint(checkpoint);
    }),

    commands.registerCommand('sidecar.executiveFunction.discard', async () => {
      await planStore.clear();
      window.showInformationMessage('SideCar: Saved task discarded.');
    }),
  );

  // Defer the startup check so it doesn't block extension activation
  setTimeout(async () => {
    if (!(await planStore.exists())) return;
    const checkpoint = await planStore.load();
    if (!checkpoint) return;

    const age = Date.now() - checkpoint.updatedAt;
    // Only prompt for tasks interrupted in the last 24 hours
    if (age > 24 * 60 * 60 * 1000) {
      await planStore.clear();
      return;
    }

    const shortGoal = checkpoint.goal.length > 60 ? checkpoint.goal.slice(0, 57) + '…' : checkpoint.goal;
    const choice = await window.showInformationMessage(
      `SideCar: Resume interrupted task? "${shortGoal}"`,
      'Resume',
      'Discard',
    );

    if (choice === 'Resume') {
      await commands.executeCommand('sidecar.executiveFunction.resume');
    } else if (choice === 'Discard') {
      await planStore.clear();
    }
  }, 2000);
}
