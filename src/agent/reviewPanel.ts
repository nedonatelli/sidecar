import {
  commands,
  window,
  workspace,
  Uri,
  EventEmitter,
  TreeItem,
  TreeItemCollapsibleState,
  ThemeIcon,
  type TreeDataProvider,
  type Event,
  type Disposable,
  type ExtensionContext,
} from 'vscode';
import * as path from 'path';
import type { PendingEditStore, PendingEdit } from './pendingEdits.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';

/**
 * Pending edits are surfaced to the user through a dedicated TreeView so
 * they can accept or discard changes file-by-file (or as a whole session)
 * before anything hits disk. The tree is a flat list of files — no
 * folders — to keep the UI simple; diffs are opened in VS Code's native
 * `vscode.diff` editor by clicking a file in the tree.
 */

const VIEW_ID = 'sidecar.reviewPanel';

/** Scheme we register for showing pending content in the diff editor. */
const BEFORE_SCHEME_KEY = (absPath: string): string => `review-before/${encodeURIComponent(absPath)}`;
const AFTER_SCHEME_KEY = (absPath: string): string => `review-after/${encodeURIComponent(absPath)}`;

/**
 * Provides tree items for the Pending Agent Changes view. Each entry in
 * the PendingEditStore becomes one item with a click command that opens
 * a before/after diff.
 */
export class ReviewTreeProvider implements TreeDataProvider<PendingEdit> {
  private readonly _onDidChange = new EventEmitter<void | PendingEdit | null | undefined>();
  readonly onDidChangeTreeData: Event<void | PendingEdit | null | undefined> = this._onDidChange.event;

  constructor(private readonly store: PendingEditStore) {
    // Bubble store changes into tree-data change events so the view
    // refreshes whenever accept / discard / new-edit happens.
    store.onChanged(() => this._onDidChange.fire());
  }

  getTreeItem(element: PendingEdit): TreeItem {
    const label = path.basename(element.filePath);
    const item = new TreeItem(label, TreeItemCollapsibleState.None);

    // Show the parent directory (relative to workspace) as the description
    // column so users can disambiguate same-named files in different dirs.
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rel =
      workspaceRoot && element.filePath.startsWith(workspaceRoot)
        ? path.relative(workspaceRoot, element.filePath)
        : element.filePath;
    item.description = path.dirname(rel) === '.' ? undefined : path.dirname(rel);
    item.tooltip = `${rel}\n\nTool: ${element.lastTool}\nUpdated: ${new Date(element.updatedAt).toLocaleTimeString()}`;

    // Icon signals "new file" vs "modified file".
    item.iconPath = element.originalContent === null ? new ThemeIcon('diff-added') : new ThemeIcon('diff-modified');

    // Stable resourceUri so VS Code can use file-type icons when the user's
    // theme prefers them. Also gives the context menu a sensible target.
    item.resourceUri = Uri.file(element.filePath);

    // contextValue drives the per-item context menu entries defined in
    // package.json — both accept and discard commands are gated on it.
    item.contextValue = 'sidecar.reviewEntry';

    // Clicking an item opens the diff editor.
    item.command = {
      command: 'sidecar.review.openDiff',
      title: 'Show pending diff',
      arguments: [element],
    };

    return item;
  }

  getChildren(element?: PendingEdit): PendingEdit[] {
    if (element) return []; // flat tree — no children of children
    return this.store.getAll();
  }
}

/**
 * Write a single pending edit to disk. Creates parent directories for
 * new files, overwrites existing files in place. Throws on I/O errors so
 * the caller can surface them to the user instead of swallowing silently.
 */
export async function applyPendingEdit(edit: PendingEdit): Promise<void> {
  const fileUri = Uri.file(edit.filePath);
  const dir = path.dirname(edit.filePath);
  if (dir && dir !== '/' && dir !== '.') {
    await workspace.fs.createDirectory(Uri.file(dir));
  }
  await workspace.fs.writeFile(fileUri, Buffer.from(edit.newContent, 'utf-8'));
}

/**
 * Open a VS Code diff editor showing a pending edit's before/after. The
 * left (baseline) side uses the captured originalContent rather than the
 * current disk content — this keeps the diff stable even if the user edits
 * the file outside SideCar while a review is pending.
 */
export async function openReviewDiff(edit: PendingEdit, contentProvider: ProposedContentProvider): Promise<void> {
  const beforeKey = BEFORE_SCHEME_KEY(edit.filePath);
  const afterKey = AFTER_SCHEME_KEY(edit.filePath);
  const beforeUri = contentProvider.addProposal(beforeKey, edit.originalContent ?? '');
  const afterUri = contentProvider.addProposal(afterKey, edit.newContent);
  const label = path.basename(edit.filePath);
  const title = edit.originalContent === null ? `${label} (new file)` : `${label} (pending review)`;
  await commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
}

/**
 * Drop the content-provider entries for a specific pending edit once the
 * user accepts or discards it. Keeps the provider's map from growing
 * unbounded across many edits.
 */
function cleanupProvider(edit: PendingEdit, contentProvider: ProposedContentProvider): void {
  contentProvider.removeProposal(BEFORE_SCHEME_KEY(edit.filePath));
  contentProvider.removeProposal(AFTER_SCHEME_KEY(edit.filePath));
}

/**
 * Register the review panel TreeView, its commands, and a click handler
 * that opens the diff editor. Returns a Disposable that tears every
 * registered piece down. Called from extension activation.
 */
export function registerReviewPanel(
  context: ExtensionContext,
  store: PendingEditStore,
  contentProvider: ProposedContentProvider,
): Disposable {
  const provider = new ReviewTreeProvider(store);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider });

  // --- Per-file accept ---
  const acceptFile = commands.registerCommand('sidecar.review.acceptFile', async (edit?: PendingEdit) => {
    const target = edit ?? (await pickPendingEdit(store, 'Select a file to accept'));
    if (!target) return;
    try {
      await applyPendingEdit(target);
      store.remove(target.filePath);
      cleanupProvider(target, contentProvider);
      window.setStatusBarMessage(`SideCar: accepted ${path.basename(target.filePath)}`, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.showErrorMessage(`SideCar: failed to write ${target.filePath}: ${msg}`);
    }
  });

  // --- Per-file discard ---
  const discardFile = commands.registerCommand('sidecar.review.discardFile', async (edit?: PendingEdit) => {
    const target = edit ?? (await pickPendingEdit(store, 'Select a file to discard'));
    if (!target) return;
    store.remove(target.filePath);
    cleanupProvider(target, contentProvider);
    window.setStatusBarMessage(`SideCar: discarded ${path.basename(target.filePath)}`, 3000);
  });

  // --- Accept all ---
  const acceptAll = commands.registerCommand('sidecar.review.acceptAll', async () => {
    const all = store.getAll();
    if (all.length === 0) {
      window.showInformationMessage('SideCar: no pending changes to accept.');
      return;
    }
    const failures: string[] = [];
    for (const edit of all) {
      try {
        await applyPendingEdit(edit);
        cleanupProvider(edit, contentProvider);
      } catch (err) {
        failures.push(`${path.basename(edit.filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Only clear entries that actually succeeded — leave failures in the
    // store so the user can retry or investigate.
    for (const edit of all) {
      if (!failures.some((f) => f.startsWith(path.basename(edit.filePath)))) {
        store.remove(edit.filePath);
      }
    }
    if (failures.length > 0) {
      window.showErrorMessage(`SideCar: ${failures.length} file(s) failed to write:\n${failures.join('\n')}`);
    } else {
      window.setStatusBarMessage(`SideCar: accepted ${all.length} file(s)`, 3000);
    }
  });

  // --- Discard all ---
  const discardAll = commands.registerCommand('sidecar.review.discardAll', async () => {
    const count = store.size;
    if (count === 0) {
      window.showInformationMessage('SideCar: no pending changes to discard.');
      return;
    }
    const choice = await window.showWarningMessage(
      `Discard all ${count} pending changes? This cannot be undone.`,
      { modal: true },
      'Discard All',
    );
    if (choice !== 'Discard All') return;
    for (const edit of store.getAll()) cleanupProvider(edit, contentProvider);
    store.clear();
    window.setStatusBarMessage(`SideCar: discarded ${count} file(s)`, 3000);
  });

  // --- Open diff (triggered by clicking a tree item) ---
  const openDiff = commands.registerCommand('sidecar.review.openDiff', async (edit?: PendingEdit) => {
    const target = edit ?? (await pickPendingEdit(store, 'Select a file to open'));
    if (!target) return;
    await openReviewDiff(target, contentProvider);
  });

  context.subscriptions.push(treeView, acceptFile, discardFile, acceptAll, discardAll, openDiff);

  return {
    dispose(): void {
      treeView.dispose();
      acceptFile.dispose();
      discardFile.dispose();
      acceptAll.dispose();
      discardAll.dispose();
      openDiff.dispose();
    },
  };
}

/**
 * When a command is triggered from the command palette (no tree-item
 * argument), fall back to a QuickPick over the pending files. Lets users
 * drive the feature without opening the TreeView.
 */
async function pickPendingEdit(store: PendingEditStore, placeholder: string): Promise<PendingEdit | undefined> {
  const all = store.getAll();
  if (all.length === 0) {
    window.showInformationMessage('SideCar: no pending changes.');
    return undefined;
  }
  const items = all.map((edit) => ({
    label: path.basename(edit.filePath),
    description: edit.filePath,
    edit,
  }));
  const picked = await window.showQuickPick(items, { placeHolder: placeholder });
  return picked?.edit;
}
