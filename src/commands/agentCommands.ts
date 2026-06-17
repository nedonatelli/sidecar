import { window, commands, workspace, ExtensionContext } from 'vscode';
import { logger } from '../system/logger.js';
import { getConfig } from '../config/settings.js';
import { clearAll as clearSidecarDiagnostics } from '../agent/sidecarDiagnostics.js';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatViewProvider } from '../webview/chatView.js';
import type { MCPManager } from '../agent/mcpManager.js';

export interface AgentCommandDeps {
  createClient: () => SideCarClient;
  getChatProvider?: () => ChatViewProvider | undefined;
  mcpManager?: MCPManager;
}

/**
 * Register audit-mode review, shadow-sweep, facets, fork, conflict-resolve,
 * diagnostics, and walkthrough commands.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function registerAgentCommands(context: ExtensionContext, extensionId: string, deps: AgentCommandDeps): void {
  const { createClient } = deps;

  context.subscriptions.push(
    commands.registerCommand('sidecar.audit.review', async () => {
      const { reviewAuditBuffer, createDefaultAuditReviewUi } = await import('../agent/audit/reviewCommands.js');
      const { getRootUri } = await import('../agent/tools/shared.js');
      const provider = deps.getChatProvider?.();
      await reviewAuditBuffer({
        rootUri: getRootUri(),
        ui: createDefaultAuditReviewUi(),
        reviewGranularity: getConfig().multiFileEditsReviewGranularity,
        postBatchSummary: provider
          ? (items) => provider.notify({ command: 'changeSummary', changeSummary: items })
          : undefined,
      });
    }),
    commands.registerCommand('sidecar.audit.acceptAll', async () => {
      const { acceptAllAuditBuffer, createDefaultAuditReviewUi } = await import('../agent/audit/reviewCommands.js');
      const { getRootUri } = await import('../agent/tools/shared.js');
      await acceptAllAuditBuffer({ rootUri: getRootUri(), ui: createDefaultAuditReviewUi() });
    }),
    commands.registerCommand('sidecar.audit.rejectAll', async () => {
      const { rejectAllAuditBuffer, createDefaultAuditReviewUi } = await import('../agent/audit/reviewCommands.js');
      const { getRootUri } = await import('../agent/tools/shared.js');
      await rejectAllAuditBuffer({ rootUri: getRootUri(), ui: createDefaultAuditReviewUi() });
    }),
    commands.registerCommand('sidecar.shadows.sweepStale', async () => {
      const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        window.showWarningMessage('SideCar: no workspace folder open — nothing to sweep.');
        return;
      }
      const { sweepStaleShadows, formatSweepResult } = await import('../agent/shadow/shadowSweep.js');
      const result = await sweepStaleShadows(root);
      const summary = formatSweepResult(result);
      if (summary) {
        window.showInformationMessage(`SideCar — ${summary}.`);
        logger.warn(`[SideCar] ${summary}`);
      } else {
        window.showInformationMessage('SideCar: no stale shadow worktrees found.');
      }
    }),
    commands.registerCommand('sidecar.facets.dispatch', async () => {
      const { runFacetDispatchCommand, createDefaultFacetCommandUi } = await import('../agent/facets/facetCommands.js');
      const { loadFacetRegistry } = await import('../agent/facets/facetDiskLoader.js');
      const { createDefaultFacetReviewUi, getWorkspaceMainRoot } = await import('../agent/facets/facetReview.js');
      const { reviewFacetBatchWithPanel } = await import('../review/reviewPanel.js');
      const cfg = getConfig();
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
      const mainRoot = getWorkspaceMainRoot();
      const provider = deps.getChatProvider?.();
      await runFacetDispatchCommand({
        ui: createDefaultFacetCommandUi(),
        loadRegistry: () =>
          loadFacetRegistry({
            workspaceRoot,
            registryPaths: cfg.facetsRegistry,
          }),
        createClient,
        agentOptions: deps.mcpManager ? { mcpManager: deps.mcpManager } : undefined,
        config: {
          enabled: cfg.facetsEnabled,
          maxConcurrent: cfg.facetsMaxConcurrent,
          rpcTimeoutMs: cfg.facetsRpcTimeoutMs,
        },
        review: mainRoot ? (batch, reviewDeps) => reviewFacetBatchWithPanel(batch, reviewDeps, context) : undefined,
        reviewDeps: mainRoot ? { ui: createDefaultFacetReviewUi(), mainRoot } : undefined,
        onBatchProgress: provider
          ? (state) =>
              provider.notify({
                command: 'batchProgress',
                batchProgress: {
                  kind: 'facets',
                  task: state.task,
                  items: state.items,
                  doneCount: state.done,
                  totalCount: state.total,
                },
              })
          : undefined,
      });
    }),
    commands.registerCommand('sidecar.fork.dispatch', async () => {
      const { runForkDispatchCommand, createDefaultForkCommandUi } = await import('../agent/fork/forkCommands.js');
      const { createDefaultForkReviewUi, getWorkspaceMainRoot } = await import('../agent/fork/forkReview.js');
      const { reviewForkBatchWithPanel } = await import('../review/reviewPanel.js');
      const cfg = getConfig();
      const mainRoot = getWorkspaceMainRoot();
      const provider = deps.getChatProvider?.();
      await runForkDispatchCommand({
        ui: createDefaultForkCommandUi(),
        createClient,
        agentOptions: deps.mcpManager ? { mcpManager: deps.mcpManager } : undefined,
        config: {
          enabled: cfg.forkEnabled,
          defaultCount: cfg.forkDefaultCount,
          maxConcurrent: cfg.forkMaxConcurrent,
        },
        review: mainRoot ? (batch, reviewDeps) => reviewForkBatchWithPanel(batch, reviewDeps, context) : undefined,
        reviewDeps: mainRoot ? { ui: createDefaultForkReviewUi(), mainRoot } : undefined,
        onBatchProgress: provider
          ? (state) =>
              provider.notify({
                command: 'batchProgress',
                batchProgress: {
                  kind: 'forks',
                  task: state.task,
                  items: state.items,
                  doneCount: state.done,
                  totalCount: state.total,
                },
              })
          : undefined,
      });
    }),
    commands.registerCommand('sidecar.resolveConflicts', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before resolving conflicts.');
        return;
      }
      const { runConflictResolution, createDefaultConflictReviewUi } = await import('../conflict/conflictReview.js');
      await runConflictResolution({
        workspaceRoot: wsFolder.uri.fsPath,
        client: createClient(),
        ui: createDefaultConflictReviewUi(),
      });
    }),
    commands.registerCommand('sidecar.clearDiagnostics', () => {
      clearSidecarDiagnostics();
      window.showInformationMessage('SideCar diagnostics cleared from Problems panel.');
    }),
    commands.registerCommand('sidecar.openWalkthrough', () => {
      commands.executeCommand('workbench.action.openWalkthrough', `${extensionId}#sidecar.gettingStarted`, false);
    }),
    commands.registerCommand('sidecar.scm.suggestCommitMessage', async () => {
      const { suggestCommitMessage } = await import('../scm/commitMessageHelper.js');
      await suggestCommitMessage(createClient);
    }),
  );
}
