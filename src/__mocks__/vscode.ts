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
  },
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  findFiles: async () => [],
  openTextDocument: async (_uri: unknown) => ({ getText: () => 'mock content' }),
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
  createTerminal: () => ({
    show: () => {},
    sendText: () => {},
    dispose: () => {},
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

export const languages = {
  getDiagnostics: (_uri?: unknown) => [],
  registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
};

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
}

export class WorkspaceEdit {
  private edits: { uri: unknown; range: Range; newText: string }[] = [];
  replace(uri: unknown, range: Range, newText: string) {
    this.edits.push({ uri, range, newText });
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

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
