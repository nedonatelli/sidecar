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
  workspace,
} from 'vscode';
import type {
  ResearchStore,
  ResearchProject,
  ExperimentManifest,
  ObservationEntry,
} from '../agent/research/researchStore.js';

type ResearchNode = ProjectNode | SectionNode | HypothesisNode | ExperimentNode | ObservationNode;

class ProjectNode implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly iconPath = new ThemeIcon('beaker');
  readonly collapsibleState = TreeItemCollapsibleState.Collapsed;
  readonly contextValue = 'researchProject';

  constructor(readonly project: ResearchProject) {
    this.label = project.title;
    this.description = project.status;
  }
}

class SectionNode implements TreeItem {
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.Collapsed;
  readonly contextValue = 'researchSection';

  constructor(
    readonly label: string,
    readonly projectSlug: string,
    readonly kind: 'hypotheses' | 'experiments' | 'observations',
    readonly count: number,
  ) {
    const icons = { hypotheses: 'lightbulb', experiments: 'microscope', observations: 'note' };
    this.iconPath = new ThemeIcon(icons[kind]);
  }

  get description(): string {
    return `${this.count}`;
  }
}

class HypothesisNode implements TreeItem {
  readonly iconPath = new ThemeIcon('circle-outline');
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'researchHypothesis';

  constructor(
    readonly label: string,
    readonly description: string,
  ) {}
}

class ExperimentNode implements TreeItem {
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'researchExperiment';
  readonly command: TreeItem['command'];

  constructor(
    readonly manifest: ExperimentManifest,
    readonly projectSlug: string,
    readonly filePath: string,
  ) {
    const icons: Record<string, string> = {
      complete: 'pass',
      running: 'loading~spin',
      planning: 'clock',
      abandoned: 'error',
    };
    this.iconPath = new ThemeIcon(icons[manifest.status] ?? 'question');
    this.command = {
      command: 'vscode.open',
      title: 'Open manifest',
      arguments: [Uri.file(filePath)],
    };
  }

  get label(): string {
    return this.manifest.id;
  }

  get description(): string {
    return this.manifest.status;
  }
}

class ObservationNode implements TreeItem {
  readonly iconPath = new ThemeIcon('comment');
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'researchObservation';
  readonly command: TreeItem['command'];

  constructor(readonly entry: ObservationEntry) {
    this.command = {
      command: 'vscode.open',
      title: 'Open observation',
      arguments: [Uri.file(entry.filePath)],
    };
  }

  get label(): string {
    return new Date(this.entry.timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  get description(): string {
    return this.entry.note.slice(0, 60).replace(/\n/g, ' ');
  }
}

class ResearchTreeProvider implements TreeDataProvider<ResearchNode> {
  private readonly _onDidChangeTreeData = new EventEmitter<ResearchNode | undefined>();
  readonly onDidChangeTreeData: Event<ResearchNode | undefined> = this._onDidChangeTreeData.event;

  constructor(private readonly store: ResearchStore) {}

  getTreeItem(element: ResearchNode): TreeItem {
    return element;
  }

  async getChildren(element?: ResearchNode): Promise<ResearchNode[]> {
    if (!element) {
      const projects = await this.store.listProjects();
      return projects.map((p) => new ProjectNode(p));
    }

    if (element instanceof ProjectNode) {
      const slug = element.project.slug;
      const [experiments, observations] = await Promise.all([
        this.store.listExperiments(slug),
        this.store.listObservations(slug),
      ]);
      return [
        new SectionNode('Hypotheses', slug, 'hypotheses', element.project.hypotheses.length),
        new SectionNode('Experiments', slug, 'experiments', experiments.length),
        new SectionNode('Observations', slug, 'observations', observations.length),
      ];
    }

    if (element instanceof SectionNode) {
      const { projectSlug, kind } = element;

      if (kind === 'hypotheses') {
        const project = await this.store.loadProject(projectSlug);
        return (project?.hypotheses ?? []).map((h) => new HypothesisNode(h.text, h.status));
      }

      if (kind === 'experiments') {
        const experiments = await this.store.listExperiments(projectSlug);
        return experiments.map((m) => {
          const filePath = this.store.getExperimentPath(projectSlug, m.id);
          return new ExperimentNode(m, projectSlug, filePath);
        });
      }

      if (kind === 'observations') {
        const observations = await this.store.listObservations(projectSlug);
        return observations.map((o) => new ObservationNode(o));
      }
    }

    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export function registerResearchView(context: ExtensionContext, store: ResearchStore): Disposable {
  const provider = new ResearchTreeProvider(store);
  const treeView = window.createTreeView('sidecar.research', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const refreshCmd = commands.registerCommand('sidecar.research.refresh', () => {
    provider.refresh();
  });

  const newProjectCmd = commands.registerCommand('sidecar.research.newProject', async () => {
    const title = await window.showInputBox({
      prompt: 'Research project title',
      placeHolder: 'e.g. "FIR vs Wavelet analysis"',
    });
    if (!title?.trim()) return;
    const question = await window.showInputBox({
      prompt: 'Central research question',
      placeHolder: 'e.g. "Does wavelet decomposition outperform FFT for detecting sub-cycle transients?"',
    });
    if (!question?.trim()) return;
    await store.createProject(title.trim(), question.trim());
    provider.refresh();
    void window.showInformationMessage(`Research project "${title}" created.`);
  });

  // Auto-refresh when the agent writes to .sidecar/research/**
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      provider.refresh();
    }, 500);
  };

  const watcher = workspace.createFileSystemWatcher('**/.sidecar/research/**');
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);

  context.subscriptions.push(treeView, provider, refreshCmd, newProjectCmd, watcher);
  return treeView;
}
