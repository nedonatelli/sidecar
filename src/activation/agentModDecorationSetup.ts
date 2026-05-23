import type { ExtensionContext } from 'vscode';
import { AgentModDecorationManager, setAgentModDecorationManager } from '../views/agentModDecoration.js';

export function initAgentModDecoration(context: ExtensionContext): AgentModDecorationManager {
  const manager = new AgentModDecorationManager();
  setAgentModDecorationManager(manager);
  context.subscriptions.push(manager);
  return manager;
}
