import {
  window,
  workspace,
  commands,
  type TextEditorDecorationType,
  type DecorationRenderOptions,
  ThemeColor,
  Range,
  Position,
  type Disposable,
  type StatusBarItem,
  StatusBarAlignment,
  Uri,
} from 'vscode';
import type { SymbolGraph } from '../../config/symbolGraph.js';
import { getConfig } from '../../config/settings.js';
import { getWorkspaceRoot } from '../../config/workspace.js';
import * as path from 'path';

// Circled digit characters for suggestion badges
const BADGES = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

export interface NextEditSuggestion {
  /** Absolute file path */
  filePath: string;
  /** 0-based line of the suggested edit site */
  line: number;
  symbolName: string;
  /** Human-readable reason, e.g. "calls changedFn (1 hop)" */
  reasoning: string;
  badgeIndex: number;
}

/**
 * Next Edit Suggestions engine (v0.72 Chunk 3).
 *
 * After the user edits a symbol, walks the SymbolGraph to find callers and
 * dependents that may also need updating. Surfaces these as ghost-text badge
 * decorations (①②③) at each candidate site and a status-bar counter for
 * cross-file hits. Tab/Alt+↓↑/Esc navigate and dismiss the suggestions.
 */
export class NextEditEngine implements Disposable {
  private readonly sameFileDecoration: TextEditorDecorationType;
  private readonly statusBar: StatusBarItem;
  private suggestions: NextEditSuggestion[] = [];
  private currentIndex = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly disposables: Disposable[] = [];

  constructor(private readonly graph: SymbolGraph) {
    const renderOptions: DecorationRenderOptions = {
      after: {
        color: new ThemeColor('editorGhostText.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 2em',
      },
      isWholeLine: false,
      rangeBehavior: 1, // ClosedOpen
    };
    this.sameFileDecoration = window.createTextEditorDecorationType(renderOptions);

    this.statusBar = window.createStatusBarItem(StatusBarAlignment.Right, 90);
    this.statusBar.command = 'sidecar.nextEdit.accept';
    this.statusBar.tooltip = 'Next Edit Suggestions — click to jump to first site (Tab)';

    this.disposables.push(
      workspace.onDidChangeTextDocument((e) => {
        const config = getConfig();
        if (!config.nextEditEnabled) return;
        if (e.contentChanges.length === 0) return;
        this.scheduleAnalysis(config.nextEditDebounceMs);
      }),
      workspace.onDidSaveTextDocument(() => {
        const config = getConfig();
        if (config.nextEditEnabled && config.nextEditAutoTriggerOnSave) {
          this.runAnalysis();
        }
      }),
      commands.registerCommand('sidecar.nextEdit.accept', () => this.accept()),
      commands.registerCommand('sidecar.nextEdit.next', () => this.navigate(1)),
      commands.registerCommand('sidecar.nextEdit.previous', () => this.navigate(-1)),
      commands.registerCommand('sidecar.nextEdit.dismiss', () => this.dismiss()),
    );
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private scheduleAnalysis(debounceMs: number): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runAnalysis();
    }, debounceMs);
  }

  private runAnalysis(): void {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const config = getConfig();

    const filePath = editor.document.uri.fsPath;
    const editLine = editor.selection.active.line;

    const suggestions = this.computeSuggestions(filePath, editLine, {
      maxHops: config.nextEditMaxHops,
      topK: config.nextEditTopK,
      crossFileEnabled: config.nextEditCrossFileEnabled,
    });

    this.suggestions = suggestions;
    this.currentIndex = 0;
    this.renderDecorations(editor.document.uri.fsPath);
  }

  // ---------------------------------------------------------------------------
  // Graph walk
  // ---------------------------------------------------------------------------

  private computeSuggestions(
    filePath: string,
    editLine: number,
    opts: { maxHops: number; topK: number; crossFileEnabled: boolean },
  ): NextEditSuggestion[] {
    const root = getWorkspaceRoot() ?? '';
    const relPath = root ? path.relative(root, filePath) : filePath;

    // Find symbols whose definition spans the edited line
    const symbols = this.graph
      .getSymbolsInFile(relPath)
      .filter((s) => editLine >= s.startLine && editLine <= s.endLine);

    const seen = new Set<string>(); // "file:line" dedup
    const results: NextEditSuggestion[] = [];

    for (const sym of symbols) {
      // Hop 1: direct callers of this symbol
      const callers = this.graph.getCallers(sym.name);
      for (const caller of callers) {
        if (!opts.crossFileEnabled && caller.callerFile !== relPath) continue;
        const key = `${caller.callerFile}:${caller.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const absPath = root ? path.resolve(root, caller.callerFile) : caller.callerFile;
        results.push({
          filePath: absPath,
          line: caller.line - 1, // convert to 0-based
          symbolName: caller.callerName,
          reasoning: `calls ${sym.name} (1 hop)`,
          badgeIndex: results.length,
        });
        if (results.length >= opts.topK) break;
      }

      if (results.length >= opts.topK) break;

      // Hop 2: files that depend on this file (import it)
      if (opts.maxHops >= 2 && opts.crossFileEnabled) {
        const dependents = this.graph.getDependents(relPath);
        for (const depFile of dependents) {
          // For each dependent, surface the first exported symbol as the suggested site
          const depSymbols = this.graph.getSymbolsInFile(depFile);
          const anchor = depSymbols[0];
          if (!anchor) continue;
          const key = `${depFile}:${anchor.startLine}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const absPath = root ? path.resolve(root, depFile) : depFile;
          results.push({
            filePath: absPath,
            line: anchor.startLine,
            symbolName: anchor.name,
            reasoning: `imports changed file (2 hops)`,
            badgeIndex: results.length,
          });
          if (results.length >= opts.topK) break;
        }
      }

      if (results.length >= opts.topK) break;
    }

    return results.slice(0, opts.topK);
  }

  // ---------------------------------------------------------------------------
  // Decorations
  // ---------------------------------------------------------------------------

  private renderDecorations(activeFilePath: string): void {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.uri.fsPath !== activeFilePath) return;

    const root = getWorkspaceRoot() ?? '';
    const relActive = root ? path.relative(root, activeFilePath) : activeFilePath;

    // Same-file decorations: place a badge at the end of the candidate line
    const sameFileRanges = this.suggestions
      .filter((s) => {
        const rel = root ? path.relative(root, s.filePath) : s.filePath;
        return rel === relActive;
      })
      .map((s) => {
        const line = Math.min(s.line, editor.document.lineCount - 1);
        const lineLen = editor.document.lineAt(line).text.length;
        const pos = new Position(line, lineLen);
        return {
          range: new Range(pos, pos),
          renderOptions: {
            after: {
              contentText: ` ${BADGES[s.badgeIndex] ?? '·'} ${s.reasoning}`,
            },
          },
        };
      });

    editor.setDecorations(this.sameFileDecoration, sameFileRanges);

    if (this.suggestions.length > 0) {
      const total = this.suggestions.length;
      const badge = BADGES[this.currentIndex] ?? '·';
      this.statusBar.text = `$(arrow-right) ${badge} ${total} next edit${total !== 1 ? 's' : ''}`;
      this.statusBar.show();
    } else {
      this.clearDecorations();
    }
  }

  private clearDecorations(): void {
    window.activeTextEditor?.setDecorations(this.sameFileDecoration, []);
    this.statusBar.hide();
    this.suggestions = [];
    this.currentIndex = 0;
  }

  // ---------------------------------------------------------------------------
  // Navigation commands
  // ---------------------------------------------------------------------------

  private async accept(): Promise<void> {
    if (this.suggestions.length === 0) return;
    await this.jumpTo(this.suggestions[this.currentIndex]);
  }

  private navigate(delta: number): void {
    if (this.suggestions.length === 0) return;
    this.currentIndex = (this.currentIndex + delta + this.suggestions.length) % this.suggestions.length;
    const active = window.activeTextEditor;
    if (active) this.renderDecorations(active.document.uri.fsPath);
  }

  private async jumpTo(suggestion: NextEditSuggestion): Promise<void> {
    const uri = Uri.file(suggestion.filePath);
    const doc = await workspace.openTextDocument(uri);
    const ed = await window.showTextDocument(doc);
    const line = Math.min(suggestion.line, doc.lineCount - 1);
    const pos = new Position(line, 0);
    ed.selection = new (await import('vscode')).Selection(pos, pos);
    ed.revealRange(new Range(pos, pos));
  }

  dismiss(): void {
    this.clearDecorations();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.dismiss();
    this.sameFileDecoration.dispose();
    this.statusBar.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
