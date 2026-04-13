import {
  languages,
  workspace,
  Range,
  Position,
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  WorkspaceEdit,
  type Disposable,
  type TextDocument,
  type CodeActionContext,
  type CodeActionProvider,
} from 'vscode';
import { analyzeSource, findDocumentedFunctions, type DocumentedFunction, type StaleTagFinding } from './jsDocSync.js';
import { getConfig } from '../config/settings.js';

const DIAGNOSTIC_SOURCE = 'SideCar JSDoc sync';
const CODE_ORPHAN = 'jsdoc-orphan-param';
const CODE_MISSING = 'jsdoc-missing-param';
const SUPPORTED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

/**
 * Wires the pure jsDocSync analyzer into VS Code. Produces diagnostics on
 * every save of a TS/JS file and registers a CodeActionProvider that turns
 * each diagnostic into a one-click quick fix.
 *
 * Disposal is handled by returning a single Disposable the extension pushes
 * onto `context.subscriptions` — this tears down every underlying listener
 * and clears the diagnostic collection.
 */
export function registerJsDocSync(): Disposable {
  const diagnostics = languages.createDiagnosticCollection('sidecar-jsdoc-sync');

  const runOnDocument = (doc: TextDocument): void => {
    if (!getConfig().jsDocSyncEnabled) {
      diagnostics.delete(doc.uri);
      return;
    }
    if (!SUPPORTED_LANGUAGES.has(doc.languageId)) return;
    // Skip oversized files — analyzer is fast but we don't want to spend it
    // on minified bundles or generated output.
    if (doc.getText().length > 500_000) return;

    const findings = analyzeSource(doc.getText());
    diagnostics.set(
      doc.uri,
      findings.flatMap((f) => toDiagnostics(f)),
    );
  };

  const onSave = workspace.onDidSaveTextDocument(runOnDocument);
  // Also run on open so files that were already stale when opened get
  // diagnosed immediately without requiring a save first.
  const onOpen = workspace.onDidOpenTextDocument(runOnDocument);
  // And react to setting toggles so users see diagnostics appear / disappear
  // without reloading the window.
  const onConfig = workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('sidecar.jsDocSync.enabled')) return;
    if (getConfig().jsDocSyncEnabled) {
      for (const doc of workspace.textDocuments) runOnDocument(doc);
    } else {
      diagnostics.clear();
    }
  });

  const provider = languages.registerCodeActionsProvider(
    Array.from(SUPPORTED_LANGUAGES).map((language) => ({ language })),
    new JsDocSyncCodeActionProvider(),
    { providedCodeActionKinds: [CodeActionKind.QuickFix] },
  );

  // Run once at registration time against any already-open documents.
  for (const doc of workspace.textDocuments) runOnDocument(doc);

  return {
    dispose(): void {
      onSave.dispose();
      onOpen.dispose();
      onConfig.dispose();
      provider.dispose();
      diagnostics.dispose();
    },
  };
}

/**
 * Convert a single stale-tag finding into 1..N VS Code diagnostics.
 * Orphan tags get a warning at their source line; missing tags get a
 * warning at the function declaration line so the dev sees it in context.
 */
export function toDiagnostics(finding: StaleTagFinding): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { fn, orphanTags, missingTags } = finding;

  for (const name of orphanTags) {
    const idx = fn.jsDocParamNames.indexOf(name);
    if (idx === -1) continue;
    const line = fn.jsDocParamLines[idx];
    const diag = new Diagnostic(
      new Range(new Position(line, 0), new Position(line, Number.MAX_SAFE_INTEGER)),
      `@param ${name} — '${name}' is no longer a parameter of ${fn.name}()`,
      DiagnosticSeverity.Warning,
    );
    diag.source = DIAGNOSTIC_SOURCE;
    diag.code = CODE_ORPHAN;
    out.push(diag);
  }

  for (const name of missingTags) {
    const diag = new Diagnostic(
      new Range(new Position(fn.declLine, 0), new Position(fn.declLine, Number.MAX_SAFE_INTEGER)),
      `${fn.name}() has a parameter '${name}' with no matching @param tag`,
      DiagnosticSeverity.Warning,
    );
    diag.source = DIAGNOSTIC_SOURCE;
    diag.code = CODE_MISSING;
    out.push(diag);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Code action provider — quick fixes
// ---------------------------------------------------------------------------

class JsDocSyncCodeActionProvider implements CodeActionProvider {
  provideCodeActions(document: TextDocument, _range: Range, context: CodeActionContext): CodeAction[] {
    const actions: CodeAction[] = [];
    const ours = context.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE);
    if (ours.length === 0) return actions;

    // Re-analyze so we have the full DocumentedFunction shape for generating edits.
    const fns = findDocumentedFunctions(document.getText());

    for (const diag of ours) {
      if (diag.code === CODE_ORPHAN) {
        const action = buildOrphanFix(document, diag, fns);
        if (action) actions.push(action);
      } else if (diag.code === CODE_MISSING) {
        const action = buildMissingFix(document, diag, fns);
        if (action) actions.push(action);
      }
    }

    return actions;
  }
}

/**
 * Quick fix: delete the orphan parameter-tag line from its JSDoc block.
 *
 * We look the owning function up by *name*, not by line number, because the
 * user may have already applied another quick fix in the same JSDoc block,
 * which would shift every subsequent line and invalidate the diagnostic's
 * stored range. Function name + parameter name together uniquely identify
 * the orphan tag across edits.
 */
export function buildOrphanFix(document: TextDocument, diag: Diagnostic, fns: DocumentedFunction[]): CodeAction | null {
  const msgMatch = diag.message.match(/^@param\s+(\w+)\s+—\s+'\1'\s+is no longer a parameter of (\w+)\(\)/);
  if (!msgMatch) return null;
  const name = msgMatch[1];
  const fnName = msgMatch[2];

  const fn = fns.find((f) => f.name === fnName);
  if (!fn) return null;
  const idx = fn.jsDocParamNames.indexOf(name);
  if (idx === -1) return null;
  // Use the re-analyzed line number, not the diagnostic's stale range.
  const line = fn.jsDocParamLines[idx];

  const action = new CodeAction(`Remove orphan @param ${name}`, CodeActionKind.QuickFix);
  action.diagnostics = [diag];
  action.isPreferred = true;
  action.edit = new WorkspaceEdit();
  action.edit.delete(document.uri, computeLineDeletionRange(document, line));
  return action;
}

/**
 * Compute the range needed to delete a whole source line cleanly. Handles
 * three shapes:
 *   - Normal line (not last): `(line, 0) → (line+1, 0)` removes content + newline.
 *   - Last line with preceding lines: remove preceding newline + content so
 *     the previous line's terminator becomes the new file terminator.
 *   - Single-line file: just clear the content in place.
 */
export function computeLineDeletionRange(document: TextDocument, line: number): Range {
  const lastLineIdx = document.lineCount - 1;
  if (line < lastLineIdx) {
    return new Range(new Position(line, 0), new Position(line + 1, 0));
  }
  if (line > 0) {
    return new Range(
      new Position(line - 1, document.lineAt(line - 1).text.length),
      new Position(line, document.lineAt(line).text.length),
    );
  }
  return new Range(new Position(0, 0), new Position(0, document.lineAt(0).text.length));
}

/**
 * Quick fix: insert a new parameter tag into the JSDoc block.
 *
 * Placement strategy:
 *   1. If the JSDoc already contains parameter tags, insert after the last one.
 *   2. Otherwise, insert immediately before `@returns` / `@return` if present.
 *   3. Otherwise, insert on the line before the closing comment terminator.
 *
 * The inserted line copies the indentation and leading `*` prefix from its
 * neighbor so the block stays visually aligned.
 *
 * Looks the owning function up by name (extracted from the diagnostic
 * message) rather than by declaration line, so the fix still resolves
 * correctly after an earlier quick fix shifted lines in the same block.
 */
export function buildMissingFix(
  document: TextDocument,
  diag: Diagnostic,
  fns: DocumentedFunction[],
): CodeAction | null {
  const msgMatch = diag.message.match(/^(\w+)\(\) has a parameter '([^']+)' with no matching @param tag/);
  if (!msgMatch) return null;
  const fnName = msgMatch[1];
  const paramName = msgMatch[2];

  const fn = fns.find((f) => f.name === fnName);
  if (!fn || fn.jsDocStartLine === null || fn.jsDocEndLine === null) return null;

  const insert = computeInsertion(document, fn, paramName);
  if (!insert) return null;

  const action = new CodeAction(`Add missing @param ${paramName}`, CodeActionKind.QuickFix);
  action.diagnostics = [diag];
  action.isPreferred = true;
  action.edit = new WorkspaceEdit();
  action.edit.insert(document.uri, insert.position, insert.text);
  return action;
}

/**
 * Compute where in the JSDoc block to insert a new parameter-tag line and
 * what text to insert (matching the surrounding indentation and leading `*`).
 */
export function computeInsertion(
  document: TextDocument,
  fn: DocumentedFunction,
  paramName: string,
): { position: Position; text: string } | null {
  if (fn.jsDocStartLine === null || fn.jsDocEndLine === null) return null;

  // Default: the line immediately above the closing `*/`.
  let anchorLine = fn.jsDocEndLine;
  let neighborLine = fn.jsDocEndLine - 1;
  if (neighborLine < fn.jsDocStartLine) neighborLine = fn.jsDocStartLine;

  // Prefer insertion after the last existing @param.
  if (fn.jsDocParamLines.length > 0) {
    const lastParamLine = fn.jsDocParamLines[fn.jsDocParamLines.length - 1];
    anchorLine = lastParamLine + 1;
    neighborLine = lastParamLine;
  } else {
    // Or immediately before @returns / @return.
    for (let i = fn.jsDocStartLine; i <= fn.jsDocEndLine; i++) {
      if (/@returns?\b/.test(document.lineAt(i).text)) {
        anchorLine = i;
        neighborLine = i;
        break;
      }
    }
  }

  // Work out the leading whitespace + `*` prefix to reuse.
  const neighborText = document.lineAt(neighborLine).text;
  const prefixMatch = neighborText.match(/^(\s*\*\s?)/);
  const prefix = prefixMatch ? prefixMatch[1] : ' * ';

  const insertText = `${prefix}@param ${paramName} \n`;
  const position = new Position(anchorLine, 0);
  return { position, text: insertText };
}
