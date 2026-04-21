import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SideCarClient } from '../ollama/client.js';
import { ShadowWorkspace } from '../agent/shadow/shadowWorkspace.js';
import { findConflictedFiles, type ConflictFile } from './conflictDetector.js';
import { resolveConflicts } from './conflictResolver.js';

// ---------------------------------------------------------------------------
// Injectable UI abstraction (keeps the core logic testable)
// ---------------------------------------------------------------------------

export interface ConflictReviewUi {
  showInfo(message: string): void;
  showError(message: string): void;
  showProgress<T>(title: string, task: (report: (msg: string) => void, signal: AbortSignal) => Promise<T>): Promise<T>;
  showFilePick(
    items: { label: string; description?: string; relativePath: string }[],
    placeHolder: string,
  ): Promise<{ relativePath: string } | undefined>;
  openDiff(before: vscode.Uri, after: vscode.Uri, title: string): Promise<void>;
  showConfirm(message: string, choices: string[]): Promise<string | undefined>;
}

export interface ConflictReviewOutcome {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly failed: readonly { path: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runConflictResolution(deps: {
  workspaceRoot: string;
  client: SideCarClient;
  ui: ConflictReviewUi;
  signal?: AbortSignal;
  findFiles?: typeof findConflictedFiles;
  createShadow?: (root: string) => ShadowWorkspace;
}): Promise<ConflictReviewOutcome> {
  const { workspaceRoot, client, ui } = deps;
  const doFindFiles = deps.findFiles ?? findConflictedFiles;
  const doCreateShadow =
    deps.createShadow ?? ((root: string) => new ShadowWorkspace({ mainRoot: root, idPrefix: 'conflict' }));

  // 1. Find conflicted files
  let conflicted: ConflictFile[];
  try {
    conflicted = await doFindFiles(workspaceRoot);
  } catch (err) {
    ui.showError(`Failed to scan for conflicts: ${err instanceof Error ? err.message : String(err)}`);
    return { accepted: [], rejected: [], failed: [] };
  }

  if (conflicted.length === 0) {
    ui.showInfo('No merge conflicts found in the workspace.');
    return { accepted: [], rejected: [], failed: [] };
  }

  // 2. Resolve conflicts via LLM inside a progress notification
  type ResolvedEntry = { file: ConflictFile; resolvedContent: string; resolvedBlocks: number };
  const resolved: ResolvedEntry[] = [];

  await ui.showProgress(
    `Resolving ${conflicted.length} conflicted file${conflicted.length > 1 ? 's' : ''}…`,
    async (report, progressSignal) => {
      const effectiveSignal = deps.signal ?? progressSignal;
      for (const file of conflicted) {
        if (effectiveSignal.aborted) break;
        report(`Resolving ${file.relativePath}…`);
        const result = await resolveConflicts(file, client, effectiveSignal);
        resolved.push({ file, resolvedContent: result.resolvedContent, resolvedBlocks: result.resolvedBlocks });
      }
    },
  );

  if (resolved.length === 0) {
    return { accepted: [], rejected: [], failed: [] };
  }

  // 3. Create shadow workspace and write resolved files into it
  const shadow = doCreateShadow(workspaceRoot);
  try {
    await shadow.create();

    for (const { file, resolvedContent } of resolved) {
      const dest = path.join(shadow.path, file.relativePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, resolvedContent, 'utf8');
    }

    // 4. Per-file review: show diff, Accept / Skip
    const accepted: string[] = [];
    const rejected: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const { file, resolvedContent, resolvedBlocks } of resolved) {
      const beforeUri = vscode.Uri.file(file.fsPath);
      const afterPath = path.join(shadow.path, file.relativePath);
      const afterUri = vscode.Uri.file(afterPath);
      const title = `Conflict: ${file.relativePath} (${resolvedBlocks}/${file.blocks.length} resolved)`;

      await ui.openDiff(beforeUri, afterUri, title);

      const choice = await ui.showConfirm(`Apply resolved ${file.relativePath}?`, ['Accept', 'Skip']);

      if (choice === 'Accept') {
        try {
          await fs.promises.writeFile(file.fsPath, resolvedContent, 'utf8');
          accepted.push(file.relativePath);
        } catch (err) {
          failed.push({ path: file.relativePath, error: err instanceof Error ? err.message : String(err) });
          ui.showError(`Failed to write ${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        rejected.push(file.relativePath);
      }
    }

    if (accepted.length > 0) {
      ui.showInfo(
        `Resolved ${accepted.length} file${accepted.length > 1 ? 's' : ''}. Stage and commit to complete the merge.`,
      );
    }

    return { accepted, rejected, failed };
  } finally {
    await shadow.dispose();
  }
}

// ---------------------------------------------------------------------------
// Production UI adapter
// ---------------------------------------------------------------------------

export function createDefaultConflictReviewUi(): ConflictReviewUi {
  return {
    showInfo: (msg) => void vscode.window.showInformationMessage(msg),
    showError: (msg) => void vscode.window.showErrorMessage(msg),

    showProgress: (title, task) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return task((_msg) => {}, ac.signal);
        },
      ) as Promise<never>,

    showFilePick: (items, placeHolder) =>
      vscode.window.showQuickPick(items, { placeHolder }) as Promise<{ relativePath: string } | undefined>,

    openDiff: (before, after, title) =>
      vscode.commands.executeCommand('vscode.diff', before, after, title) as Promise<void>,

    showConfirm: (message, choices) =>
      vscode.window.showInformationMessage(message, ...choices) as Promise<string | undefined>,
  };
}
