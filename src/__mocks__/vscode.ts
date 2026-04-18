// Minimal vscode module mock for unit tests

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
  parse: (str: string) => {
    const colonIdx = str.indexOf(':');
    const scheme = colonIdx > 0 ? str.slice(0, colonIdx) : 'file';
    const pathPart = colonIdx > 0 ? str.slice(colonIdx + 1) : str;
    return { fsPath: pathPart, scheme, path: pathPart };
  },
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join('/');
    return { fsPath: joined, scheme: 'file', path: joined };
  },
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };
  }
  fire(data: T) {
    for (const l of this.listeners) l(data);
  }
  dispose() {
    this.listeners = [];
  }
}

const noopDisposable = { dispose: () => {} };
const noopEvent = () => noopDisposable;

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: '/mock-workspace' }, name: 'mock', index: 0 }],
  // Default to trusted — individual tests that need to exercise the
  // untrusted path override this via vi.spyOn or direct assignment.
  isTrusted: true,
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T) => defaultValue,
    inspect: (_key: string) => ({ workspaceValue: undefined, globalValue: undefined }),
    update: async () => {},
  }),
  fs: {
    readFile: async (_uri: unknown) => Buffer.from('mock file content'),
    writeFile: async (_uri: unknown, _content: Uint8Array) => {},
    readDirectory: async (_uri: unknown) => [],
    stat: async (_uri: unknown) => ({ type: 1, size: 100 }),
    rename: async (_source: unknown, _target: unknown, _options?: unknown) => {},
    createDirectory: async (_uri: unknown) => {},
    delete: async (_uri: unknown, _options?: unknown) => {},
  },
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  findFiles: async () => [],
  openTextDocument: async (uriOrOpts: unknown) => {
    // Tests that pass `{ content }` expect an untitled-style URI; tests
    // that pass a Uri expect `.uri` to point at that Uri. Keep the shape
    // realistic enough that callers destructuring `doc.uri` don't blow up.
    const maybeUri = (uriOrOpts as { fsPath?: string } | undefined)?.fsPath
      ? (uriOrOpts as { fsPath: string })
      : { fsPath: 'untitled:mock', scheme: 'untitled', path: 'untitled:mock' };
    return { getText: () => 'mock content', uri: maybeUri };
  },
  createFileSystemWatcher: () => ({
    onDidCreate: noopEvent,
    onDidChange: noopEvent,
    onDidDelete: noopEvent,
    dispose: () => {},
  }),
};

export const window = {
  activeTextEditor: undefined,
  showQuickPick: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showTextDocument: async () => undefined,
  showInputBox: async () => undefined,
  withProgress: async (_opts: unknown, task: (progress: unknown) => Promise<unknown>) => task({}),
  onDidCloseTerminal: () => ({ dispose: () => {} }),
  onDidEndTerminalShellExecution: () => ({ dispose: () => {} }),
  onDidChangeTerminalShellIntegration: () => ({ dispose: () => {} }),
  createTerminal: () => ({
    show: () => {},
    sendText: () => {},
    dispose: () => {},
    exitStatus: undefined,
    // No shellIntegration by default — tests that exercise the
    // AgentTerminalExecutor happy path override this via
    // `vi.spyOn(window, 'createTerminal').mockReturnValue(...)`.
    shellIntegration: undefined,
  }),
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: () => ({
    text: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
};

export const authentication = {
  getSession: async () => null,
};

// Minimal in-memory DiagnosticCollection that tests can introspect.
// Keyed by fsPath so tests can poke at .get() without constructing
// full Uri objects.
class MockDiagnosticCollection {
  private readonly store = new Map<string, unknown[]>();
  constructor(public readonly name: string) {}
  set(uri: { fsPath: string }, diagnostics: unknown[]): void {
    this.store.set(uri.fsPath, diagnostics);
  }
  get(uri: { fsPath: string }): unknown[] | undefined {
    return this.store.get(uri.fsPath);
  }
  delete(uri: { fsPath: string }): void {
    this.store.delete(uri.fsPath);
  }
  clear(): void {
    this.store.clear();
  }
  dispose(): void {
    this.store.clear();
  }
  get size(): number {
    return this.store.size;
  }
  forEach(cb: (uri: { fsPath: string }, diagnostics: unknown[]) => void): void {
    for (const [fsPath, diagnostics] of this.store) {
      cb({ fsPath }, diagnostics);
    }
  }
}

export const languages = {
  getDiagnostics: (_uri?: unknown) => [],
  registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
  createDiagnosticCollection: (name: string) => new MockDiagnosticCollection(name),
};

export class Diagnostic {
  public source?: string;
  public code?: string | number;
  constructor(
    public range: unknown,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export const env = {
  clipboard: { writeText: async () => {} },
};

export const commands = {
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  cancel() {}
  dispose() {}
}

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export const CodeActionKind = {
  QuickFix: { value: 'quickfix' },
  RefactorRewrite: { value: 'refactor.rewrite' },
  Empty: { value: '' },
};

export class CodeAction {
  public diagnostics?: unknown[];
  public command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public title: string,
    public kind?: { value: string },
  ) {}
}

export class WorkspaceEdit {
  private edits: { uri: unknown; range: Range; newText: string }[] = [];
  replace(uri: unknown, range: Range, newText: string) {
    this.edits.push({ uri, range, newText });
  }
  insert(uri: unknown, position: Position, newText: string) {
    // In the real VS Code API, `insert` is a zero-length replace at a
    // given position. Model it as such so tests that walk edits see a
    // Range(position, position) entry rather than blowing up on a
    // missing method.
    this.edits.push({ uri, range: new Range(position, position), newText });
  }
  get size() {
    return this.edits.length;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  One = 1,
  Two = 2,
  Three = 3,
}

export enum InlineCompletionTriggerKind {
  Invoke = 0,
  Automatic = 1,
}

export class InlineCompletionItem {
  constructor(
    public insertText: string,
    public range?: Range,
  ) {}
}

export class Selection extends Range {}

export class ThemeColor {
  constructor(public id: string) {}
}

export class FileDecoration {
  public propagate?: boolean;
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: ThemeColor,
  ) {}
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
