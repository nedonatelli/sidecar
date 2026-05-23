import {
  CodeLens,
  Range,
  Position,
  EventEmitter,
  type TextDocument,
  type CancellationToken,
  type CodeLensProvider,
  type Event,
} from 'vscode';

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  typescriptreact: [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  javascript: [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  javascriptreact: [
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  python: [/^\s*def\s+\w+/, /^\s*class\s+\w+\s*[:(]/, /^\s*async\s+def\s+\w+/],
  go: [/^func\s+/, /^\s*func\s+\(/],
  rust: [/^\s*(pub\s+)?(async\s+)?fn\s+\w+/, /^\s*struct\s+\w+/, /^\s*impl\s+/],
};

const TODO_PATTERN = /^\s*(?:\/\/|#|--)?\s*(?:TODO|FIXME|HACK|XXX)\b/;

const MAX_LENSES = 50;
const CLUSTER_GAP = 2;

export class SidecarCodeLensProvider implements CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new EventEmitter<void>();
  readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;

  provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
    const patterns = SYMBOL_PATTERNS[document.languageId] ?? [];
    const lenses: CodeLens[] = [];
    let lastLensLine = -CLUSTER_GAP - 1;

    for (let i = 0; i < document.lineCount && lenses.length < MAX_LENSES; i++) {
      const text = document.lineAt(i).text;

      if (i - lastLensLine <= CLUSTER_GAP) continue;

      let action: 'explain' | 'fix' | null = null;
      if (patterns.some((p) => p.test(text))) {
        action = 'explain';
      } else if (TODO_PATTERN.test(text)) {
        action = 'fix';
      }

      if (action !== null) {
        const range = new Range(new Position(i, 0), new Position(i, 0));
        lenses.push(
          new CodeLens(range, {
            title: action === 'explain' ? '⚡ SideCar: Explain' : '⚡ SideCar: Fix',
            command: 'sidecar.codelens.invoke',
            arguments: [{ startLine: i, endLine: i, action }],
          }),
        );
        lastLensLine = i;
      }
    }

    return lenses;
  }

  resolveCodeLens(lens: CodeLens, _token: CancellationToken): CodeLens {
    return lens;
  }
}
