import {
  languages,
  workspace,
  Uri,
  Range,
  Position,
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  WorkspaceEdit,
  RelativePattern,
  type Disposable,
  type TextDocument,
  type CodeActionContext,
  type CodeActionProvider,
} from 'vscode';
import * as path from 'path';
import {
  findExportedFunctions,
  detectStaleReferences,
  type ExportedFunction,
  type StaleReference,
} from './readmeSync.js';
import { getConfig } from '../config/settings.js';

const DIAGNOSTIC_SOURCE = 'SideCar README sync';
const CODE_STALE_CALL = 'readme-stale-call';
const SOURCE_GLOB = 'src/**/*.{ts,tsx,js,jsx}';

/**
 * An in-memory index of every top-level exported function discovered in
 * `src/**\/*.{ts,tsx,js,jsx}`. Keyed by absolute file path so individual
 * files can be re-scanned when they save without rebuilding the whole map.
 *
 * When multiple files export the same name, the first-scanned definition
 * wins. This matches the behavior users expect when a README reference is
 * ambiguous — we don't try to disambiguate, we just pick one.
 */
export class ExportIndex {
  private bySourceFile = new Map<string, ExportedFunction[]>();

  /**
   * Scan every source file under the workspace src/ tree and populate the
   * index. Safe to await from activate() — it runs asynchronously and
   * doesn't block the extension from finishing its startup.
   */
  async buildInitial(): Promise<void> {
    const files = await workspace.findFiles(SOURCE_GLOB, '**/node_modules/**');
    await Promise.all(files.map((uri) => this.scanFile(uri)));
  }

  /** Re-scan a single file and replace its entry in the index. */
  async scanFile(uri: Uri): Promise<void> {
    try {
      const bytes = await workspace.fs.readFile(uri);
      const source = Buffer.from(bytes).toString('utf-8');
      this.bySourceFile.set(uri.fsPath, findExportedFunctions(source));
    } catch {
      // File unreadable (rename, delete, permissions) — drop it from the index
      // so stale entries can't haunt future lookups.
      this.bySourceFile.delete(uri.fsPath);
    }
  }

  /** Forget about a source file (on delete or rename). */
  remove(uri: Uri): void {
    this.bySourceFile.delete(uri.fsPath);
  }

  /**
   * Return a name→function map built from every scanned file. Called fresh
   * each time the README is re-analyzed. Cheap because each per-file entry
   * is already parsed; building the map is a linear pass.
   */
  getByName(): Map<string, ExportedFunction> {
    const out = new Map<string, ExportedFunction>();
    for (const fns of this.bySourceFile.values()) {
      for (const fn of fns) {
        if (!out.has(fn.name)) out.set(fn.name, fn);
      }
    }
    return out;
  }

  /** Test hook — inspect how many files the index currently tracks. */
  get size(): number {
    return this.bySourceFile.size;
  }
}

/**
 * Wire the README sync analyzer into VS Code. Watches README.md for save /
 * open events, watches every source file under src/ for save events (to
 * refresh the export index and re-analyze the README), and registers a
 * CodeActionProvider that offers arity-fix quick fixes on stale call lines.
 *
 * Returns a single Disposable that tears down every listener, unregisters
 * the provider, and clears the diagnostic collection.
 */
export function registerReadmeSync(): Disposable {
  const diagnostics = languages.createDiagnosticCollection('sidecar-readme-sync');
  const index = new ExportIndex();

  // Kick off the initial scan in the background so activate() returns fast.
  // README analysis that runs before the scan completes simply sees an
  // empty index and produces no findings — next save picks up the truth.
  void index.buildInitial();

  const runOnReadme = (doc: TextDocument): void => {
    if (!getConfig().readmeSyncEnabled) {
      diagnostics.delete(doc.uri);
      return;
    }
    if (!isReadmeUri(doc.uri)) return;

    const exports = index.getByName();
    const stale = detectStaleReferences(doc.getText(), exports);
    diagnostics.set(
      doc.uri,
      stale.map((s) => toDiagnostic(s)),
    );
  };

  /**
   * Handle a save of any document. Branches on URI:
   *   - README.md → re-run the README check.
   *   - src/ source file → re-scan that file, then re-run the check on any
   *     open README (catches the "I edited the signature, now the docs are
   *     stale" case without requiring the user to re-save the README).
   */
  const onSave = workspace.onDidSaveTextDocument(async (doc) => {
    if (isReadmeUri(doc.uri)) {
      runOnReadme(doc);
      return;
    }
    if (isSourceFileUri(doc.uri)) {
      await index.scanFile(doc.uri);
      const readme = findOpenReadme();
      if (readme) runOnReadme(readme);
    }
  });

  // Open events only matter for README — source-file opens don't invalidate
  // anything the index already knows.
  const onOpen = workspace.onDidOpenTextDocument(runOnReadme);

  const onConfig = workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('sidecar.readmeSync.enabled')) return;
    if (getConfig().readmeSyncEnabled) {
      const readme = findOpenReadme();
      if (readme) runOnReadme(readme);
    } else {
      diagnostics.clear();
    }
  });

  // Watch for source file deletions/creates outside the editor (e.g. `rm`,
  // `mv` on the command line). Keeps the export index honest even when edits
  // come from outside VS Code.
  const roots = workspace.workspaceFolders ?? [];
  const watchers: Disposable[] = [];
  for (const folder of roots) {
    const watcher = workspace.createFileSystemWatcher(new RelativePattern(folder, SOURCE_GLOB));
    watchers.push(
      watcher.onDidCreate((uri) => {
        void index.scanFile(uri).then(() => {
          const readme = findOpenReadme();
          if (readme) runOnReadme(readme);
        });
      }),
      watcher.onDidChange((uri) => {
        void index.scanFile(uri).then(() => {
          const readme = findOpenReadme();
          if (readme) runOnReadme(readme);
        });
      }),
      watcher.onDidDelete((uri) => {
        index.remove(uri);
        const readme = findOpenReadme();
        if (readme) runOnReadme(readme);
      }),
      watcher,
    );
  }

  const provider = languages.registerCodeActionsProvider(
    { language: 'markdown' },
    new ReadmeSyncCodeActionProvider(index),
    { providedCodeActionKinds: [CodeActionKind.QuickFix] },
  );

  // Run once at registration time so an already-open README gets diagnosed
  // on extension activation without a user save.
  const initial = findOpenReadme();
  if (initial) runOnReadme(initial);

  return {
    dispose(): void {
      onSave.dispose();
      onOpen.dispose();
      onConfig.dispose();
      for (const w of watchers) w.dispose();
      provider.dispose();
      diagnostics.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * True iff the URI points at a workspace-root README.md. Case-sensitive on
 * the filename because most OSes normalize to README.md and we don't want
 * to match arbitrary *.md files.
 */
export function isReadmeUri(uri: Uri): boolean {
  const base = path.basename(uri.fsPath);
  if (base !== 'README.md') return false;
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;
  return folders.some((f) => path.dirname(uri.fsPath) === f.uri.fsPath);
}

/**
 * True iff the URI points at a TypeScript / JavaScript source file under
 * a workspace `src/` directory. Used to decide whether a save event should
 * trigger an export-index refresh.
 */
export function isSourceFileUri(uri: Uri): boolean {
  const ext = path.extname(uri.fsPath);
  if (!/\.(ts|tsx|js|jsx)$/.test(ext)) return false;
  if (uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) return false;
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;
  return folders.some((f) => {
    const srcRoot = path.join(f.uri.fsPath, 'src');
    return uri.fsPath.startsWith(srcRoot + path.sep);
  });
}

/**
 * Find an already-open README.md document, or null if none is open. Used
 * when a source file save wants to invalidate README diagnostics — no
 * point re-analyzing a README the user isn't looking at.
 */
function findOpenReadme(): TextDocument | null {
  for (const doc of workspace.textDocuments) {
    if (isReadmeUri(doc.uri)) return doc;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

/**
 * Convert a stale-reference finding into a VS Code Diagnostic. The range
 * spans exactly the call expression in the README so VS Code's squiggle
 * lands on the bad line and the quick-fix lightbulb has a clear target.
 */
export function toDiagnostic(ref: StaleReference): Diagnostic {
  const argWord = ref.expected === 1 ? 'argument' : 'arguments';
  const gotWord = ref.actual === 1 ? 'argument' : 'arguments';
  const msg = `${ref.fn.name}() takes ${ref.expected} ${argWord} but the README passes ${ref.actual} ${gotWord}`;
  const diag = new Diagnostic(
    new Range(new Position(ref.call.line, ref.call.startCol), new Position(ref.call.line, ref.call.endCol)),
    msg,
    DiagnosticSeverity.Warning,
  );
  diag.source = DIAGNOSTIC_SOURCE;
  diag.code = CODE_STALE_CALL;
  return diag;
}

// ---------------------------------------------------------------------------
// Code action provider — quick fixes
// ---------------------------------------------------------------------------

class ReadmeSyncCodeActionProvider implements CodeActionProvider {
  constructor(private readonly index: ExportIndex) {}

  provideCodeActions(document: TextDocument, _range: Range, context: CodeActionContext): CodeAction[] {
    const ours = context.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE);
    if (ours.length === 0) return [];

    // Re-analyze the README against the current export index. The set of
    // stale references here reflects the *current* file contents and the
    // *current* export index — both of which may have drifted since the
    // diagnostic was produced. We match diagnostics to current references
    // by function name + line number so stale diagnostic ranges from an
    // earlier edit don't block the fix.
    const exports = this.index.getByName();
    const stale = detectStaleReferences(document.getText(), exports);

    const actions: CodeAction[] = [];
    for (const diag of ours) {
      const action = buildArityFix(document, diag, stale, exports);
      if (action) actions.push(action);
    }
    return actions;
  }
}

/**
 * Build a quick fix that rewrites a stale call so its argument count matches
 * the current signature. Two behaviors:
 *   - Too many args → drop the trailing args.
 *   - Too few args  → append the missing parameter names as placeholders
 *     (so the user lands on a call that's syntactically valid but clearly
 *     needs a real value).
 */
export function buildArityFix(
  document: TextDocument,
  diag: Diagnostic,
  currentStale: StaleReference[],
  exportsByName: Map<string, ExportedFunction>,
): CodeAction | null {
  const msgMatch = diag.message.match(/^(\w+)\(\) takes \d+ arguments? but/);
  if (!msgMatch) return null;
  const fnName = msgMatch[1];

  // Match the diagnostic to a currently-stale call by function name and line.
  // Name+line is stable across intra-line edits but not cross-line edits;
  // that's acceptable — cross-line edits will trigger a re-save anyway.
  const diagLine = diag.range.start.line;
  const match = currentStale.find((s) => s.fn.name === fnName && s.call.line === diagLine);
  if (!match) return null;

  const fn = exportsByName.get(fnName);
  if (!fn) return null;

  // Build the new argument list.
  let newArgs: string[];
  if (match.actual > match.expected) {
    newArgs = match.call.args.slice(0, match.expected);
  } else {
    // Fill the tail with parameter names so the user sees what's missing.
    const missing = fn.paramNames.slice(match.actual);
    newArgs = [...match.call.args, ...missing];
  }

  const newText = `${fnName}(${newArgs.join(', ')})`;

  const action = new CodeAction(
    `Update call to ${fnName}() (${match.expected} argument${match.expected === 1 ? '' : 's'})`,
    CodeActionKind.QuickFix,
  );
  action.diagnostics = [diag];
  action.isPreferred = true;
  action.edit = new WorkspaceEdit();
  const range = new Range(
    new Position(match.call.line, match.call.startCol),
    new Position(match.call.line, match.call.endCol),
  );
  action.edit.replace(document.uri, range, newText);
  return action;
}
