import * as vscode from 'vscode';
import { getDefaultAuditBuffer } from '../agent/audit/auditBuffer.js';

let _instance: AuditFileDecorationProvider | null = null;

export function getAuditDecorationProvider(): AuditFileDecorationProvider | null {
  return _instance;
}

export function setAuditDecorationProvider(p: AuditFileDecorationProvider): void {
  _instance = p;
}

export class AuditFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const buf = getDefaultAuditBuffer();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const rel = uri.fsPath.startsWith(wsRoot) ? uri.fsPath.slice(wsRoot.length + 1).replace(/\\/g, '/') : null;
    if (!rel) return undefined;
    const state = buf.read(rel);
    if (!state.buffered) return undefined;
    if (state.deleted) {
      return {
        badge: '✗',
        tooltip: 'SideCar: pending delete',
        color: new vscode.ThemeColor('errorForeground'),
      };
    }
    return {
      badge: '~',
      tooltip: 'SideCar: pending change',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    };
  }

  refresh(uris?: vscode.Uri[]): void {
    this._onDidChange.fire(uris);
  }
}
