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

const ADAPTIVE_PASTE_COMMAND = 'sidecar.adaptivePaste.transform';

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
 * Adaptive Paste (v0.72 Chunk 4).
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
 * Registers the `sidecar.adaptivePaste.transform` command that drives the
 * interactive transform flow: QuickPick → LLM call → in-place replacement.
 */
export function registerAdaptivePasteCommand(client: SideCarClient, tracker: AdaptivePasteTracker): Disposable {
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

      await window.withProgress(
        { location: 15 /* ProgressLocation.Notification */, title: `SideCar: Transforming paste (${chosen.name})…` },
        async () => {
          try {
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

            const edit = new WorkspaceEdit();
            edit.replace(editor.document.uri, paste.range, transformed.trim());
            await workspace.applyEdit(edit);
            tracker.clearLastPaste();
          } catch (err) {
            void window.showErrorMessage(
              `SideCar: Transform failed — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    },
  );
}
