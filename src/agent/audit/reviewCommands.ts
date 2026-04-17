import { window, workspace, commands, Uri } from 'vscode';
import * as path from 'path';
import { getDefaultAuditBuffer, AuditFlushError, type AuditBuffer, type BufferedChange } from './auditBuffer.js';

/**
 * Audit Mode review commands — the user-facing side of the buffer
 * primitive. These three handlers are the only way buffered agent
 * writes reach disk or get dropped: review lists pending entries and
 * dispatches to accept/reject bulk actions or single-file diff, accept
 * flushes every entry atomically via `workspace.fs`, and reject clears
 * the buffer after a confirmation prompt.
 *
 * Handlers are split out here (not inlined in extension.ts) so tests
 * can drive them through a small `AuditReviewDeps` shim instead of
 * stubbing module-scoped VS Code APIs.
 */

/**
 * Minimal UI surface the review handlers need. Production wiring
 * passes a shim that routes to `window.showInformationMessage`,
 * `showQuickPick`, etc.; tests pass a deterministic fake.
 */
export interface AuditReviewUi {
  /** Pick one item from a list, or undefined when the user cancels. */
  showQuickPick<T extends { label: string }>(items: T[], placeholder: string): Promise<T | undefined>;
  /** Fire-and-forget info toast. */
  showInfo(message: string): void;
  /** Modal confirmation — resolves with the user's choice label, or undefined on cancel. */
  showWarningConfirm(message: string, confirmLabel: string): Promise<string | undefined>;
  /** Fire-and-forget error toast. */
  showError(message: string): void;
  /** Open VS Code's diff editor showing the two URIs side-by-side. */
  openDiff(beforeUri: Uri, afterUri: Uri, title: string): Promise<void>;
}

/**
 * Injection point for tests. Production code uses the singleton buffer
 * and the real workspace root; tests supply their own.
 */
export interface AuditReviewDeps {
  /** Defaults to the process-wide singleton. */
  buffer?: AuditBuffer;
  /** Workspace root used to resolve relative paths on flush. */
  rootUri: Uri;
  /** UI surface — real shim in production, fake in tests. */
  ui: AuditReviewUi;
}

/** Tag every pick item with the action it triggers — `open` also carries the entry. */
type ReviewPick =
  | { label: string; description?: string; action: 'accept-all' }
  | { label: string; description?: string; action: 'reject-all' }
  | { label: string; description?: string; action: 'open'; entry: BufferedChange };

function formatEntryLabel(entry: BufferedChange): { label: string; description: string } {
  const opMark =
    entry.op === 'create' ? '$(diff-added)' : entry.op === 'delete' ? '$(diff-removed)' : '$(diff-modified)';
  const sizeHint =
    entry.op === 'delete' ? 'delete' : entry.content !== undefined ? `${entry.content.length} chars` : '';
  return { label: `${opMark} ${entry.path}`, description: sizeHint };
}

/**
 * Entry point for `sidecar.audit.review`. Shows a picker listing bulk
 * actions + each buffered file; dispatches to the relevant handler
 * based on the user's pick. Returning early on an empty buffer avoids
 * a confusing "nothing to do" pick dialog.
 */
export async function reviewAuditBuffer(deps: AuditReviewDeps): Promise<void> {
  const buf = deps.buffer ?? getDefaultAuditBuffer();
  const entries = buf.list();
  if (entries.length === 0) {
    deps.ui.showInfo('SideCar audit: buffer is empty — no pending changes.');
    return;
  }

  const items: ReviewPick[] = [
    {
      label: '$(check-all) Accept All',
      description: `${entries.length} file${entries.length === 1 ? '' : 's'}`,
      action: 'accept-all',
    },
    { label: '$(discard) Reject All', description: 'Drop every buffered change', action: 'reject-all' },
    ...entries.map((entry): ReviewPick => {
      const fmt = formatEntryLabel(entry);
      return { label: fmt.label, description: fmt.description, action: 'open', entry };
    }),
  ];

  const picked = await deps.ui.showQuickPick(items, 'SideCar audit: review buffered changes');
  if (!picked) return;

  if (picked.action === 'accept-all') {
    await acceptAllAuditBuffer(deps);
    return;
  }
  if (picked.action === 'reject-all') {
    await rejectAllAuditBuffer(deps);
    return;
  }
  // 'open' — diff the buffered version against the captured original.
  await openBufferedDiff(picked.entry, deps);
}

/**
 * Open VS Code's native diff editor showing the captured originalContent
 * on the left and the buffered new content on the right. Uses untitled
 * docs so we don't need to register a content provider just for Audit
 * Mode — the tradeoff is the diff tabs aren't bookmarkable, but for a
 * one-shot review surface that's fine.
 */
async function openBufferedDiff(entry: BufferedChange, deps: AuditReviewDeps): Promise<void> {
  const beforeText = entry.originalContent ?? '';
  const afterText = entry.op === 'delete' ? '' : (entry.content ?? '');
  const beforeDoc = await workspace.openTextDocument({ content: beforeText });
  const afterDoc = await workspace.openTextDocument({ content: afterText });
  const title = `${path.basename(entry.path)} (audit ${entry.op})`;
  await deps.ui.openDiff(beforeDoc.uri, afterDoc.uri, title);
}

/**
 * Entry point for `sidecar.audit.acceptAll`. Flushes every buffered
 * change to disk via `workspace.fs`. On success the buffer empties;
 * on partial failure the rollback inside `AuditBuffer.flush` has
 * already restored pre-flush disk state, and this handler surfaces
 * the error to the user via the UI shim.
 */
export async function acceptAllAuditBuffer(deps: AuditReviewDeps): Promise<void> {
  const buf = deps.buffer ?? getDefaultAuditBuffer();
  if (buf.isEmpty) {
    deps.ui.showInfo('SideCar audit: buffer is empty — nothing to accept.');
    return;
  }

  const writeDisk = async (relPath: string, content: string): Promise<void> => {
    const fileUri = Uri.joinPath(deps.rootUri, relPath);
    const dir = path.dirname(relPath);
    if (dir && dir !== '.') {
      await workspace.fs.createDirectory(Uri.joinPath(deps.rootUri, dir));
    }
    await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
  };
  const deleteDisk = async (relPath: string): Promise<void> => {
    const fileUri = Uri.joinPath(deps.rootUri, relPath);
    await workspace.fs.delete(fileUri, { useTrash: true });
  };

  try {
    const result = await buf.flush(writeDisk, deleteDisk);
    const n = result.applied.length;
    deps.ui.showInfo(`SideCar audit: accepted ${n} change${n === 1 ? '' : 's'}.`);
  } catch (err) {
    if (err instanceof AuditFlushError) {
      deps.ui.showError(
        `SideCar audit flush failed: ${err.message} ` +
          `Rolled back ${err.applied.length} prior write${err.applied.length === 1 ? '' : 's'}; buffer preserved so you can retry.`,
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`SideCar audit flush errored: ${msg}`);
  }
}

/**
 * Entry point for `sidecar.audit.rejectAll`. Confirms with the user,
 * then clears the buffer without touching disk. The confirmation is
 * modal-ish (via warning dialog) because this is an irreversible drop
 * of agent work — if the user dismisses the dialog, the buffer stays.
 */
export async function rejectAllAuditBuffer(deps: AuditReviewDeps): Promise<void> {
  const buf = deps.buffer ?? getDefaultAuditBuffer();
  const count = buf.size;
  if (count === 0) {
    deps.ui.showInfo('SideCar audit: buffer is empty — nothing to reject.');
    return;
  }

  const choice = await deps.ui.showWarningConfirm(
    `Reject all ${count} buffered change${count === 1 ? '' : 's'}? This discards the agent's work for this session.`,
    'Reject All',
  );
  if (choice !== 'Reject All') return;

  buf.clear();
  deps.ui.showInfo(`SideCar audit: rejected ${count} change${count === 1 ? '' : 's'}.`);
}

/**
 * Shim that binds the abstract UI surface to real VS Code APIs.
 * Factored out so extension.ts can register the commands with a
 * one-liner and tests don't have to touch `window.*`.
 */
export function createDefaultAuditReviewUi(): AuditReviewUi {
  return {
    async showQuickPick(items, placeholder) {
      return window.showQuickPick(items, { placeHolder: placeholder });
    },
    showInfo(message) {
      void window.showInformationMessage(message);
    },
    async showWarningConfirm(message, confirmLabel) {
      return window.showWarningMessage(message, { modal: true }, confirmLabel);
    },
    showError(message) {
      void window.showErrorMessage(message);
    },
    async openDiff(beforeUri, afterUri, title) {
      await commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
    },
  };
}
