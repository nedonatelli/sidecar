import { workspace, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { TerminalManager } from '../terminal/manager.js';
import { ProposedContentProvider } from '../edits/proposedContentProvider.js';
import { AgentLogger } from '../agent/logger.js';
import { MCPManager } from '../agent/mcpManager.js';
import { DiagnosticSubscriber } from '../agent/diagnosticSubscriber.js';
import { getProcessRegistry } from '../agent/processLifecycle.js';
import { logger, SESSION_ID, kv } from '../system/logger.js';
import type { SideCarConfig } from '../config/settings.js';

export interface BaseServices {
  terminalManager: TerminalManager;
  proposedContentProvider: ProposedContentProvider;
  agentLogger: AgentLogger;
  mcpManager: MCPManager;
}

/**
 * Create and register the core VS Code service objects needed by most subsystems:
 * TerminalManager, ProposedContentProvider, AgentLogger, MCPManager, ProcessRegistry,
 * and DiagnosticSubscriber.
 * Extracted from extension.ts to keep the entry point lean.
 */
export function initBaseServices(context: ExtensionContext, config: SideCarConfig): BaseServices {
  logger.info(`[SideCar] activating${kv({ session: SESSION_ID, version: context.extension?.packageJSON?.version })}`);

  const terminalManager = new TerminalManager();
  context.subscriptions.push(terminalManager);

  const proposedContentProvider = new ProposedContentProvider();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider('sidecar-proposed', proposedContentProvider),
  );

  const agentLogger = new AgentLogger();
  context.subscriptions.push(agentLogger);

  const mcpManager = new MCPManager();
  context.subscriptions.push(mcpManager);

  context.subscriptions.push(getProcessRegistry());

  const diagnosticSubscriber = new DiagnosticSubscriber(
    {
      enabled: config.diagnosticsReactiveFixEnabled,
      debounceMs: config.diagnosticsReactiveFixDebounceMs,
      severity: config.diagnosticsReactiveFixSeverity,
    },
    async (_uri, _diagnostics) => {
      // Reactive diagnostic fixing deferred — requires runAgentLoopInSandbox + review UI integration
    },
  );
  context.subscriptions.push(diagnosticSubscriber);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.diagnostics')) {
        const cfg = getConfig();
        diagnosticSubscriber.reconfigure({
          enabled: cfg.diagnosticsReactiveFixEnabled,
          debounceMs: cfg.diagnosticsReactiveFixDebounceMs,
          severity: cfg.diagnosticsReactiveFixSeverity,
        });
      }
    }),
  );

  return { terminalManager, proposedContentProvider, agentLogger, mcpManager };
}
