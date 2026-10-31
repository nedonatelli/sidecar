import {
  window,
  workspace,
  commands,
  CodeAction,
  CodeActionKind,
  Range,
  WorkspaceEdit,
  type CodeActionProvider,
  type Selection,
  type TextDocument,
  type Disposable,
  type TextDocumentChangeEvent,
} from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import { getConfig } from '../config/settings.js';
import { detectTransforms, type PasteTransform } from './pasteTransforms.js';
import { cleanResolution } from '../conflict/conflictResolver.js';
import { resolveMode } from '../config/settings/agent.js';
import { previewKey, type ProposedContentProvider } from './proposedContentProvider.js';

const ADAPTIVE_PASTE_COMMAND = 'sidecar.adaptivePaste.transform';

/**
 * The model's transform, shaped to replace the paste (#165 ML-62). It was
 * written `trim()`med: the first line lost its indentation, a line-wise paste
 * lost its trailing newline and glued itself to the next line, and a fenced
 * answer went in fence and all. Same cleaning as AI conflict resolution: unwrap
 * a fence around the whole answer, drop leading blank lines only, drop trailing
 * whitespace. Then restore the paste's trailing line break, and write the
 * document's own line endings.
 */
export function fitTransformed(raw: string, pasted: string, eol: '\n' | '\r\n'): string {
  let text = cleanResolution(raw).replace(/\r?\n/g, eol);
  if (/\r?\n$/.test(pasted)) text += eol;
  return text;
}

/**
 * Tracks the most recent "likely paste" in each document: a single
 * text insertion longer than the configured threshold.
 */
interface PasteRecord {
  text: string;
  range: Range;
  documentUri: string;
  languageId: string;
}

/**
 * Adaptive Paste .
 *
 * Two parts:
 *
 * 1. `AdaptivePasteTracker` — listens to `onDidChangeTextDocument` for
 *    large single-chunk insertions (heuristic for paste events) and records
 *    the last paste per document so the code action provider can read it.
 *
 * 2. `AdaptivePasteCodeActionProvider` — a `CodeActionProvider` that, when
 *    the user's selection overlaps a recorded paste, checks whether the pasted
 *    text matches any built-in transform and offers a lightbulb action.
 *
 * The actual transform runs through `sidecar.adaptivePaste.transform` which
 * calls the LLM with a focused single-turn prompt and replaces the paste range
 * in place.
 */
export class AdaptivePasteTracker implements Disposable {
  private lastPaste: PasteRecord | null = null;
  private readonly listener: Disposable;

  constructor() {
    this.listener = workspace.onDidChangeTextDocument((e: TextDocumentChangeEvent) => {
      const config = getConfig();
      if (!config.adaptivePasteEnabled || !config.adaptivePasteAutoDetect) return;

      // Only care about single-chunk insertions longer than the threshold.
      // Multiple changes in one event = auto-format or snippet, not a paste.
      if (e.contentChanges.length !== 1) return;
      const change = e.contentChanges[0];
      if (change.text.length < config.adaptivePasteMinPasteLength) return;
      // Insertions only (empty range replaced with text)
      if (!change.range.isEmpty) return;

      const end = e.document.positionAt(e.document.offsetAt(change.range.start) + change.text.length);
      this.lastPaste = {
        text: change.text,
        range: new Range(change.range.start, end),
        documentUri: e.document.uri.toString(),
        languageId: e.document.languageId,
      };
    });
  }

  getLastPaste(): PasteRecord | null {
    return this.lastPaste;
  }

  clearLastPaste(): void {
    this.lastPaste = null;
  }

  dispose(): void {
    this.listener.dispose();
  }
}

export class AdaptivePasteCodeActionProvider implements CodeActionProvider {
  public static readonly providedCodeActionKinds = [CodeActionKind.RefactorRewrite];

  constructor(private readonly tracker: AdaptivePasteTracker) {}

  public provideCodeActions(document: TextDocument, range: Range | Selection): CodeAction[] {
    if (!getConfig().adaptivePasteEnabled) return [];

    const paste = this.tracker.getLastPaste();
    if (!paste) return [];
    if (paste.documentUri !== document.uri.toString()) return [];

    // Only surface the action when the selection overlaps the pasted range
    if (!range.intersection(paste.range)) return [];

    const transforms = detectTransforms(paste.text, paste.languageId);
    if (transforms.length === 0) return [];

    const action = new CodeAction('Transform paste with SideCar…', CodeActionKind.RefactorRewrite);
    action.command = {
      command: ADAPTIVE_PASTE_COMMAND,
      title: 'Transform paste with SideCar',
      arguments: [{ paste, transforms }],
    };
    return [action];
  }
}

/**
 * Where the pasted text is NOW. The recorded range is from the moment of the
 * paste; any edit above it since then (including while the model was
 * transforming it) shifts the text, and replacing the stale range overwrote
 * whatever had moved into it. Returns the recorded range if it still holds
 * the pasted text, else the text's single current location, else null.
 */
export function currentPasteRange(document: TextDocument, paste: PasteRecord): Range | null {
  if (document.getText(paste.range) === paste.text) return paste.range;
  const all = document.getText();
  const at = all.indexOf(paste.text);
  if (at === -1 || all.indexOf(paste.text, at + 1) !== -1) return null;
  return new Range(document.positionAt(at), document.positionAt(at + paste.text.length));
}

/**
 * Show the document with the paste replaced as a diff against the live one, and
 * ask. True only on Accept; closing the prompt counts as Reject. The proposal is
 * dropped either way.
 */
export async function previewReplacement(
  document: TextDocument,
  target: Range,
  replacement: string,
  provider: ProposedContentProvider,
): Promise<boolean> {
  const text = document.getText();
  const proposed =
    text.slice(0, document.offsetAt(target.start)) + replacement + text.slice(document.offsetAt(target.end));
  const key = previewKey(workspace.asRelativePath(document.uri, false));
  const proposedUri = provider.addProposal(key, proposed);
  try {
    await commands.executeCommand('vscode.diff', document.uri, proposedUri, 'SideCar: transformed paste', {
      preview: true,
    });
    const choice = await window.showInformationMessage(
      'Replace the paste with the transformed version?',
      'Accept',
      'Reject',
    );
    return choice === 'Accept';
  } finally {
    provider.removeProposal(key);
  }
}

/**
 * Registers the `sidecar.adaptivePaste.transform` command that drives the
 * interactive transform flow: QuickPick → LLM call → (preview) → in-place
 * replacement.
 *
 * Given a `preview` provider, every mode but autonomous shows the transformed
 * document as a diff first and replaces the paste only on Accept (#165 ML-62):
 * the model's answer used to go straight in, unseen.
 */
export function registerAdaptivePasteCommand(
  clientOrFactory: SideCarClient | (() => SideCarClient),
  tracker: AdaptivePasteTracker,
  preview?: ProposedContentProvider,
): Disposable {
  return commands.registerCommand(
    ADAPTIVE_PASTE_COMMAND,
    async (args?: { paste: PasteRecord; transforms: PasteTransform[] }) => {
      if (!args) return;

      const { paste, transforms } = args;

      // Let the user pick a transform when more than one matches
      let chosen: PasteTransform;
      if (transforms.length === 1) {
        chosen = transforms[0];
      } else {
        const pick = await window.showQuickPick(
          transforms.map((t) => ({ label: t.name, description: t.description, transform: t })),
          { placeHolder: 'Choose how to transform the pasted content' },
        );
        if (!pick) return;
        chosen = pick.transform;
      }

      const editor = window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== paste.documentUri) return;

      const lang = editor.document.languageId;
      const systemPrompt =
        'You are a code transformation assistant. Transform the pasted content so it fits naturally into the target file. ' +
        'Output ONLY the transformed code — no explanations, no markdown fences.';
      const userMessage =
        `Target language: ${lang}\n\n` +
        `Instruction: ${chosen.transformInstruction}\n\n` +
        `Pasted content:\n${paste.text}`;

      const config = getConfig();
      const overrideModel = config.adaptivePasteModel || undefined;
      let pending: { target: Range; replacement: string } | undefined;

      await window.withProgress(
        { location: 15 /* ProgressLocation.Notification */, title: `SideCar: Transforming paste (${chosen.name})…` },
        async () => {
          try {
            const client = typeof clientOrFactory === 'function' ? clientOrFactory() : clientOrFactory;
            const transformed = await client.completeWithOverrides(
              systemPrompt,
              [{ role: 'user', content: userMessage }],
              overrideModel,
              2048,
              new AbortController().signal,
            );

            if (!transformed?.trim()) {
              void window.showErrorMessage('SideCar: Transform returned empty result.');
              return;
            }

            const target = currentPasteRange(editor.document, paste);
            if (!target) {
              void window.showWarningMessage(
                'SideCar: The pasted text changed or moved while transforming, so nothing was replaced.',
              );
              return;
            }
            // EndOfLine.CRLF is 2.
            const eol = editor.document.eol === 2 ? '\r\n' : '\n';
            pending = { target, replacement: fitTransformed(transformed, paste.text, eol) };
          } catch (err) {
            void window.showErrorMessage(
              `SideCar: Transform failed — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
      if (!pending) return;

      // After the progress notification closes, so it does not spin while
      // the diff is read.
      if (preview && resolveMode(config.agentMode, config.customModes).approvalBehavior !== 'autonomous') {
        if (!(await previewReplacement(editor.document, pending.target, pending.replacement, preview))) return;
        // The document can change while the diff is open, as during the
        // transform (#119): find the paste again, or replace nothing.
        const target = currentPasteRange(editor.document, paste);
        if (!target) {
          void window.showWarningMessage(
            'SideCar: The pasted text changed or moved while the preview was open, so nothing was replaced.',
          );
          return;
        }
        pending.target = target;
      }

      try {
        const edit = new WorkspaceEdit();
        edit.replace(editor.document.uri, pending.target, pending.replacement);
        await workspace.applyEdit(edit);
        tracker.clearLastPaste();
      } catch (err) {
        void window.showErrorMessage(`SideCar: Transform failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
