import { window, type ExtensionContext } from 'vscode';
import { AuditFileDecorationProvider, setAuditDecorationProvider } from '../testing/auditDecorations.js';

export function initAuditDecorations(context: ExtensionContext): void {
  const provider = new AuditFileDecorationProvider();
  setAuditDecorationProvider(provider);
  context.subscriptions.push(window.registerFileDecorationProvider(provider));
}
