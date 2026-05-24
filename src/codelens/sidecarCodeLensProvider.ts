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

export type CodeLensAction = 'explain' | 'fix' | 'addTests' | 'refactor';

export interface CodeLensArgs {
  startLine: number;
  action: CodeLensAction;
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  typescriptreact: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  javascript: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  javascriptreact: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?class\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
    /^\s*(describe|it|test)\s*\(/,
  ],
  python: [/^\s*def\s+\w+/, /^\s*class\s+\w+\s*[:(]/, /^\s*async\s+def\s+\w+/],
  go: [/^func\s+/, /^\s*func\s+\(/],
  rust: [/^\s*(pub\s+)?(async\s+)?fn\s+\w+/, /^\s*struct\s+\w+/, /^\s*impl\s+/],
};

const TODO_PATTERN = /^\s*(?:\/\/|#|--)?\s*(?:TODO|FIXME|HACK|XXX)\b/;

// Max distinct symbol locations before we stop adding lenses.
const MAX_SYMBOLS = 25;
// Minimum line gap between adjacent symbol locations to avoid dense clusters.
const CLUSTER_GAP = 3;

/** Find the last line of the symbol starting at startLine (0-indexed). */
export function findSymbolEnd(document: TextDocument, startLine: number): number {
  const langId = document.languageId;
  const cap = Math.min(startLine + 120, document.lineCount - 1);

  if (langId === 'python') {
    // Python: indentation-based. Find the next def/class/async def
    // at the same or shallower indentation level.
    const startIndent = document.lineAt(startLine).firstNonWhitespaceCharacterIndex;
    for (let i = startLine + 1; i <= cap; i++) {
      const line = document.lineAt(i);
      if (line.isEmptyOrWhitespace) continue;
      const indent = line.firstNonWhitespaceCharacterIndex;
      const text = line.text.trimStart();
      if (
        indent <= startIndent &&
        (text.startsWith('def ') || text.startsWith('class ') || text.startsWith('async def '))
      ) {
        return i - 1;
      }
    }
    return cap;
  }

  // Brace-based languages: walk forward tracking {/} depth.
  let depth = 0;
  let enteredBody = false;
  for (let i = startLine; i <= cap; i++) {
    const text = document.lineAt(i).text;
    for (const ch of text) {
      if (ch === '{') {
        depth++;
        enteredBody = true;
      } else if (ch === '}') {
        depth--;
        if (enteredBody && depth === 0) return i;
      }
    }
  }
  return cap;
}

export class SidecarCodeLensProvider implements CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new EventEmitter<void>();
  readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
    const patterns = SYMBOL_PATTERNS[document.languageId] ?? [];
    const lenses: CodeLens[] = [];
    let lastSymbolLine = -CLUSTER_GAP - 1;
    let symbolCount = 0;

    for (let i = 0; i < document.lineCount && symbolCount < MAX_SYMBOLS; i++) {
      const text = document.lineAt(i).text;

      if (i - lastSymbolLine <= CLUSTER_GAP) continue;

      const range = new Range(new Position(i, 0), new Position(i, 0));

      if (patterns.some((p) => p.test(text))) {
        lenses.push(
          makeLens(range, '⚡ Explain', 'explain', i),
          makeLens(range, '⚡ Add tests', 'addTests', i),
          makeLens(range, '⚡ Refactor', 'refactor', i),
        );
        lastSymbolLine = i;
        symbolCount++;
      } else if (TODO_PATTERN.test(text)) {
        lenses.push(makeLens(range, '⚡ Fix', 'fix', i));
        lastSymbolLine = i;
        symbolCount++;
      }
    }

    return lenses;
  }

  resolveCodeLens(lens: CodeLens, _token: CancellationToken): CodeLens {
    return lens;
  }
}

function makeLens(range: Range, title: string, action: CodeLensAction, startLine: number): CodeLens {
  return new CodeLens(range, {
    title,
    command: 'sidecar.codelens.invoke',
    arguments: [{ startLine, action } satisfies CodeLensArgs],
  });
}
