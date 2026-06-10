import {
  type Disposable,
  type ExtensionContext,
  type TreeDataProvider,
  type TreeItem,
  TreeItemCollapsibleState,
  EventEmitter,
  type Event,
  window,
  ThemeIcon,
  commands,
  Uri,
} from 'vscode';

const VIEW_ID = 'sidecar.eval';

export type EvalCaseStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface EvalCaseState {
  id: string;
  status: EvalCaseStatus;
}

const STATUS_ICON: Record<EvalCaseStatus, string> = {
  pending: 'circle-large-outline',
  running: 'sync~spin',
  passed: 'pass',
  failed: 'error',
};

const STATUS_LABEL: Record<EvalCaseStatus, string> = {
  pending: 'pending',
  running: 'running…',
  passed: 'passed',
  failed: 'failed',
};

class EvalHeaderItem implements TreeItem {
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'evalHeader';
  label: string;
  description: string;
  iconPath: ThemeIcon;

  constructor(model: string, done: number, total: number, running: boolean) {
    this.label = `Smoke eval — ${model}`;
    this.description = running ? `${done} / ${total}` : done === total && total > 0 ? `${done} / ${total} ✓` : '';
    this.iconPath = new ThemeIcon(running ? 'sync~spin' : done === total && total > 0 ? 'pass-filled' : 'beaker');
  }
}

class EvalCaseItem implements TreeItem {
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'evalCase';
  readonly label: string;
  readonly description: string;
  readonly iconPath: ThemeIcon;

  constructor(readonly state: EvalCaseState) {
    this.label = state.id;
    this.description = STATUS_LABEL[state.status];
    this.iconPath = new ThemeIcon(STATUS_ICON[state.status]);
  }
}

type EvalItem = EvalHeaderItem | EvalCaseItem;

export class EvalTreeProvider implements TreeDataProvider<EvalItem>, Disposable {
  private readonly _onDidChangeTreeData = new EventEmitter<EvalItem | undefined>();
  readonly onDidChangeTreeData: Event<EvalItem | undefined> = this._onDidChangeTreeData.event;

  private model = '';
  private cases: EvalCaseState[] = [];
  private running = false;
  private reportPath = '';

  getTreeItem(element: EvalItem): TreeItem {
    return element;
  }

  getChildren(element?: EvalItem): EvalItem[] {
    if (element) return [];
    if (!this.running && this.cases.length === 0) return [];

    const done = this.cases.filter((c) => c.status === 'passed' || c.status === 'failed').length;
    const header = new EvalHeaderItem(this.model, done, this.cases.length, this.running);
    const caseItems = this.cases.map((c) => new EvalCaseItem(c));
    return [header, ...caseItems];
  }

  start(model: string, totalHint: number): void {
    this.model = model;
    this.running = true;
    this.cases = Array.from({ length: totalHint }, (_, i) => ({ id: `case ${i + 1}`, status: 'pending' }));
    this.reportPath = '';
    this._onDidChangeTreeData.fire(undefined);
    void commands.executeCommand(`${VIEW_ID}.focus`);
  }

  updateCase(caseId: string, status: EvalCaseStatus): void {
    const existing = this.cases.find((c) => c.id === caseId);
    if (existing) {
      existing.status = status;
    } else {
      // Replace the first placeholder 'pending' slot, or append.
      const placeholder = this.cases.find((c) => c.id.startsWith('case ') && c.status === 'pending');
      if (placeholder) {
        placeholder.id = caseId;
        placeholder.status = status;
      } else {
        this.cases.push({ id: caseId, status });
      }
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  markRunning(caseId: string): void {
    // Replace next placeholder with the actual case id in running state.
    const placeholder = this.cases.find((c) => c.id.startsWith('case ') && c.status === 'pending');
    if (placeholder) {
      placeholder.id = caseId;
      placeholder.status = 'running';
    } else {
      const existing = this.cases.find((c) => c.id === caseId);
      if (existing) {
        existing.status = 'running';
      } else {
        this.cases.push({ id: caseId, status: 'running' });
      }
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  finish(reportPath: string): void {
    this.running = false;
    this.reportPath = reportPath;
    // Any remaining running/pending → pending (timed out or skipped).
    for (const c of this.cases) {
      if (c.status === 'running' || c.status === 'pending') c.status = 'pending';
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getReportPath(): string {
    return this.reportPath;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export function registerEvalView(context: ExtensionContext): EvalTreeProvider {
  const provider = new EvalTreeProvider();

  const treeView = window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    treeView,
    provider,
    commands.registerCommand('sidecar.eval.openReport', () => {
      const p = provider.getReportPath();
      if (p) void commands.executeCommand('vscode.open', Uri.file(p));
      else void window.showInformationMessage('No eval report available yet.');
    }),
  );

  return provider;
}
