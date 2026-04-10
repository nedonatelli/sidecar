// Minimal vscode module mock for unit tests

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join('/');
    return { fsPath: joined, scheme: 'file', path: joined };
  },
};

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
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
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
