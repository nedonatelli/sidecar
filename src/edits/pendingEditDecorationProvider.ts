import {
  EventEmitter,
  FileDecoration,
  ThemeColor,
  Uri,
  type Disposable,
  type Event,
  type FileDecorationProvider,
} from 'vscode';
import type { PendingEditStore } from '../agent/pendingEdits.js';

/**
 * Decorates files with pending agent edits in the Explorer, tabs, and
 * anywhere else VS Code renders a `FileDecoration`.
 *
 * Design:
 *   - Badge: a single-character "P" so the user can scan for pending
 *     changes at a glance. Git uses single-character badges (M/A/D/U)
 *     for the same reason — more than one character crowds the tree.
 *   - Colour: ties into `gitDecoration.modifiedResourceForeground` so
 *     it reads as "this file has uncommitted changes" in every theme.
 *     Falls back to `charts.orange` if the git colour is unavailable.
 *   - Tooltip: "SideCar — pending agent edit". Shows on hover over the
 *     file node in the Explorer.
 *
 * We refresh by firing `onDidChangeFileDecorations` with the union of
 * the previous and current pending paths, so files that were just
 * accepted / discarded have their badge cleared. That's cheaper than
 * passing `undefined` (which would force VS Code to refresh every
 * visible file), and it's what the built-in git decoration provider
 * does.
 */
export class PendingEditDecorationProvider implements FileDecorationProvider, Disposable {
  private readonly _onDidChange = new EventEmitter<Uri[]>();
  readonly onDidChangeFileDecorations: Event<Uri[]> = this._onDidChange.event;

  private readonly subscription: Disposable;
  private lastDecorated = new Set<string>();

  constructor(private readonly store: PendingEditStore) {
    this.subscription = store.onChanged(() => this.refresh());
    // Seed the initial snapshot so any files already present when the
    // provider registers get decorated without waiting for a change.
    this.lastDecorated = new Set(store.getAll().map((e) => e.filePath));
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    if (!this.store.has(uri.fsPath)) return undefined;
    const decoration = new FileDecoration(
      'P',
      'SideCar — pending agent edit',
      new ThemeColor('gitDecoration.modifiedResourceForeground'),
    );
    // propagate=true so parent folders in the Explorer show a subtle
    // indicator too, matching how git rolls up modified descendants.
    decoration.propagate = true;
    return decoration;
  }

  /**
   * Compute the set difference between the previous snapshot and the
   * current one, then fire a single decoration refresh event covering
   * every file whose state changed (added or removed).
   */
  private refresh(): void {
    const current = new Set(this.store.getAll().map((e) => e.filePath));
    const changed = new Set<string>();
    for (const p of current) {
      if (!this.lastDecorated.has(p)) changed.add(p);
    }
    for (const p of this.lastDecorated) {
      if (!current.has(p)) changed.add(p);
    }
    this.lastDecorated = current;
    if (changed.size === 0) return;
    const uris = Array.from(changed, (fsPath) => Uri.file(fsPath));
    this._onDidChange.fire(uris);
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChange.dispose();
  }
}
