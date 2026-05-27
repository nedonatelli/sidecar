import { window, workspace, Uri, FileType } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { computeUnifiedDiff } from '../../agent/diff.js';
import { languageToExtension } from './messageUtils.js';
import { ShellSession } from '../../terminal/shellSession.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);

function isWithinRoot(fileUri: Uri, rootUri: Uri): boolean {
  const root = rootUri.fsPath;
  const file = fileUri.fsPath;
  return file === root || file.startsWith(root + path.sep);
}

export async function handleAttachFile(state: ChatState): Promise<void> {
  const editor = window.activeTextEditor;

  const options: string[] = [];
  if (editor) {
    options.push('Active File: ' + path.basename(editor.document.fileName));
  }
  options.push('Browse...');

  const pick =
    options.length === 1 ? options[0] : await window.showQuickPick(options, { placeHolder: 'Select a file to attach' });
  if (!pick) return;

  if (pick.startsWith('Active File') && editor) {
    const fileName = path.basename(editor.document.fileName);
    const ext = path.extname(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      await attachImage(state, Uri.file(editor.document.fileName));
    } else {
      const fileContent = editor.document.getText();
      if (fileContent.length > 500_000) {
        window.showWarningMessage(`File "${fileName}" is too large to attach (>500KB).`);
        return;
      }
      state.postMessage({ command: 'fileAttached', fileName, fileContent });
    }
  } else {
    const uris = await window.showOpenDialog({ canSelectMany: false });
    if (!uris || uris.length === 0) return;
    const fileName = path.basename(uris[0].fsPath);
    const ext = path.extname(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      await attachImage(state, uris[0]);
    } else {
      const doc = await workspace.openTextDocument(uris[0]);
      const fileContent = doc.getText();
      if (fileContent.length > 500_000) {
        window.showWarningMessage(`File "${fileName}" is too large to attach (>500KB).`);
        return;
      }
      state.postMessage({ command: 'fileAttached', fileName, fileContent });
    }
  }
}

/**
 * Attach the currently active editor file directly — no quick-pick menu.
 * Used by the active-file bar toggle button in the chat input area.
 */
export async function handleAttachActiveFile(state: ChatState): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor) return;
  const fileName = path.basename(editor.document.fileName);
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    await attachImage(state, Uri.file(editor.document.fileName));
    return;
  }
  const fileContent = editor.document.getText();
  if (fileContent.length > 500_000) {
    void window.showWarningMessage(`File "${fileName}" is too large to attach (>500KB).`);
    return;
  }
  state.postMessage({ command: 'fileAttached', fileName, fileContent });
}

// Caps for drag-drop: we'd rather quietly truncate than flood the model
// with 50MB of junk. These match handleAttachFile's per-file ceiling and
// pick round numbers for the multi-file limits.
const MAX_ATTACHMENT_BYTES = 500_000;
const MAX_ATTACHMENTS_PER_DROP = 20;
const MAX_FOLDER_ENTRIES = 10;
const SKIPPED_DIR_ENTRIES = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', '.venv']);

function isProbablyBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/**
 * Handle files/folders dropped onto the chat webview. Files are read and
 * posted as `filesAttached`; folders have their immediate children read
 * (non-recursive) and filtered to a handful of text files. Size, count,
 * and binary-content limits protect the model context from getting
 * flooded by an accidental drop.
 */
export async function handleDroppedPaths(state: ChatState, paths: string[]): Promise<void> {
  if (!paths || paths.length === 0) return;

  const collected: { fileName: string; fileContent: string }[] = [];
  const skipped: string[] = [];

  const tryReadFile = async (uri: Uri, displayName: string, size: number): Promise<void> => {
    if (collected.length >= MAX_ATTACHMENTS_PER_DROP) return;
    if (size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${displayName} (>${Math.floor(MAX_ATTACHMENT_BYTES / 1000)}KB)`);
      return;
    }
    try {
      const bytes = await workspace.fs.readFile(uri);
      if (isProbablyBinary(bytes)) {
        skipped.push(`${displayName} (binary)`);
        return;
      }
      collected.push({ fileName: displayName, fileContent: Buffer.from(bytes).toString('utf-8') });
    } catch {
      skipped.push(`${displayName} (unreadable)`);
    }
  };

  for (const raw of paths) {
    if (collected.length >= MAX_ATTACHMENTS_PER_DROP) break;
    if (!raw) continue;

    // The webview sends either file:// URIs or raw fsPaths; normalize both.
    let uri: Uri;
    try {
      uri = raw.startsWith('file://') ? Uri.parse(raw) : Uri.file(raw);
    } catch {
      skipped.push(`${raw} (invalid path)`);
      continue;
    }

    let stat;
    try {
      stat = await workspace.fs.stat(uri);
    } catch {
      skipped.push(`${path.basename(raw)} (not found)`);
      continue;
    }

    if (stat.type === FileType.File) {
      await tryReadFile(uri, path.basename(uri.fsPath), stat.size);
      continue;
    }

    if (stat.type === FileType.Directory) {
      let entries: [string, FileType][];
      try {
        entries = (await workspace.fs.readDirectory(uri)) as [string, FileType][];
      } catch {
        skipped.push(`${path.basename(raw)} (unreadable folder)`);
        continue;
      }
      const folderName = path.basename(uri.fsPath);
      let taken = 0;
      let eligible = 0;
      for (const [name, type] of entries) {
        if (name.startsWith('.')) continue;
        if (SKIPPED_DIR_ENTRIES.has(name)) continue;
        if (type !== FileType.File) continue;
        eligible++;
        if (collected.length >= MAX_ATTACHMENTS_PER_DROP) continue;
        if (taken >= MAX_FOLDER_ENTRIES) continue;
        const childUri = Uri.joinPath(uri, name);
        try {
          const childStat = await workspace.fs.stat(childUri);
          await tryReadFile(childUri, `${folderName}/${name}`, childStat.size);
          taken++;
        } catch {
          skipped.push(`${folderName}/${name} (unreadable)`);
        }
      }
      if (eligible > taken) {
        skipped.push(`${folderName}/ (${eligible - taken} more file${eligible - taken === 1 ? '' : 's'} not attached)`);
      }
      continue;
    }

    skipped.push(`${path.basename(raw)} (unsupported type)`);
  }

  if (collected.length > 0) {
    state.postMessage({ command: 'filesAttached', files: collected });
  }

  if (skipped.length > 0) {
    const suffix =
      collected.length > 0 ? ` Attached ${collected.length} file${collected.length === 1 ? '' : 's'}.` : '';
    window.showInformationMessage(
      `SideCar: skipped ${skipped.length} dropped item${skipped.length === 1 ? '' : 's'} — ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}.${suffix}`,
    );
  }
}

export async function attachImage(state: ChatState, uri: Uri): Promise<void> {
  const bytes = await workspace.fs.readFile(uri);
  const ext = path.extname(uri.fsPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  const mediaType = mimeMap[ext] || 'image/png';
  const data = Buffer.from(bytes).toString('base64');
  state.postMessage({ command: 'imageAttached', mediaType, data });
}

export async function handleSaveCodeBlock(code: string, language?: string): Promise<void> {
  const ext = language ? languageToExtension(language) : '.txt';
  const uri = await window.showSaveDialog({
    filters: { 'All Files': ['*'] },
    defaultUri: Uri.file('untitled' + ext),
  });
  if (!uri) return;

  await workspace.fs.writeFile(uri, Buffer.from(code, 'utf-8'));
  window.showInformationMessage(`Saved to ${path.basename(uri.fsPath)}`);
}

export async function handleCreateFile(state: ChatState, code: string, filePath: string): Promise<void> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const rootUri = workspaceFolders[0].uri;
  const fileUri = Uri.joinPath(rootUri, filePath);
  if (!isWithinRoot(fileUri, rootUri)) {
    state.postMessage({ command: 'error', content: 'Invalid file path.' });
    return;
  }

  let exists = false;
  try {
    await workspace.fs.stat(fileUri);
    exists = true;
  } catch {
    // File doesn't exist
  }

  if (exists) {
    const choice = await state.requestConfirm(`"${filePath}" already exists. Overwrite?`, ['Overwrite', 'Cancel']);
    if (choice !== 'Overwrite') return;
  }

  try {
    await workspace.fs.createDirectory(Uri.joinPath(rootUri, path.dirname(filePath)));
    await workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf-8'));
    window.showInformationMessage(`Created ${filePath}`);
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to create file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function handleRunCommand(state: ChatState, command: string): Promise<string | null> {
  const choice = await state.requestConfirm(`SideCar wants to run: \`${command}\``, ['Allow', 'Deny']);
  if (choice !== 'Allow') {
    state.postMessage({ command: 'commandResult', content: 'Command cancelled by user.' });
    return null;
  }

  const terminalOutput = await state.terminalManager.executeCommand(command);
  if (terminalOutput !== null) {
    return terminalOutput;
  }

  // Fallback path — terminal manager couldn't run the command (e.g. no
  // shell integration available). Route through ShellSession rather
  // than raw child_process.exec so the hardened per-command prefix
  // (alias/function namespace reset from shellSession.ts) still applies.
  // Previously this path bypassed that hardening, which meant an earlier
  // turn's shell function or alias could silently hijack what the user
  // approved in the confirmation modal. Audit cycle-2 MEDIUM #13.
  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return '(no workspace folder)';
  const session = new ShellSession(cwd);
  try {
    const result = await session.execute(command, { timeout: 30_000 });
    return result.stdout.trim() || '(no output)';
  } catch (err) {
    return err instanceof Error ? err.message : 'Command failed';
  } finally {
    session.dispose();
  }
}

export async function handleMoveFile(state: ChatState, sourcePath: string, destPath: string): Promise<void> {
  if (!sourcePath || !destPath) {
    state.postMessage({ command: 'error', content: 'Move requires both a source and destination path.' });
    return;
  }

  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const rootUri = workspaceFolders[0].uri;
  const sourceUri = path.isAbsolute(sourcePath) ? Uri.file(sourcePath) : Uri.joinPath(rootUri, sourcePath);
  const destUri = path.isAbsolute(destPath) ? Uri.file(destPath) : Uri.joinPath(rootUri, destPath);
  if (!isWithinRoot(sourceUri, rootUri) || !isWithinRoot(destUri, rootUri)) {
    state.postMessage({ command: 'error', content: 'Invalid file path.' });
    return;
  }

  try {
    await workspace.fs.stat(sourceUri);
  } catch {
    state.postMessage({ command: 'error', content: `Source not found: ${sourcePath}` });
    return;
  }

  let destExists = false;
  try {
    await workspace.fs.stat(destUri);
    destExists = true;
  } catch {
    // safe
  }

  if (destExists) {
    const choice = await state.requestConfirm(`"${destPath}" already exists. Overwrite?`, ['Overwrite', 'Cancel']);
    if (choice !== 'Overwrite') {
      state.postMessage({ command: 'fileMoved', content: 'Move cancelled.' });
      return;
    }
  }

  try {
    await workspace.fs.rename(sourceUri, destUri, { overwrite: destExists });
    state.postMessage({ command: 'fileMoved', content: `Moved "${sourcePath}" to "${destPath}"` });
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to move file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function handleUndoChanges(state: ChatState): Promise<void> {
  if (!state.changelog.hasChanges()) {
    window.showInformationMessage('No changes to undo.');
    return;
  }
  const changes = state.changelog.getChanges();
  const choice = await state.requestConfirm(`Undo ${changes.length} file change(s) made by SideCar?`, [
    'Undo All',
    'Cancel',
  ]);
  if (choice !== 'Undo All') return;
  const result = await state.changelog.rollbackAll();
  const parts: string[] = [];
  if (result.restored > 0) parts.push(`${result.restored} restored`);
  if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  window.showInformationMessage(`Undo complete: ${parts.join(', ')}`);
  state.postMessage({
    command: 'assistantMessage',
    content: `\n\n↩ Undid ${changes.length} file change(s): ${parts.join(', ')}`,
  });
}

export async function handleRevertFile(state: ChatState, filePath: string): Promise<void> {
  // Remove from audit buffer if present — audit mode stores writes there,
  // not in state.changelog, so "revert file" should also drop the buffered entry.
  const { getDefaultAuditBuffer } = await import('../../agent/audit/auditBuffer.js');
  const buf = getDefaultAuditBuffer();
  const wasBuffered = buf.has(filePath);
  if (wasBuffered) buf.clear([filePath]);

  const success = wasBuffered || (await state.changelog.rollbackFile(filePath));
  if (success) {
    state.postMessage({
      command: 'assistantMessage',
      content: `\n\n↩ Reverted **${filePath}**`,
    });
  } else {
    state.postMessage({
      command: 'error',
      content: `Failed to revert ${filePath}`,
    });
  }

  // Send updated change summary
  if (state.changelog.hasChanges()) {
    const changes = await state.changelog.getChangeSummary();
    const summaryItems = changes
      .map((c) => ({
        filePath: c.filePath,
        diff: computeUnifiedDiff(c.filePath, c.original, c.current),
        isNew: c.original === null,
        isDeleted: c.current === null,
      }))
      .filter((item) => item.diff.length > 0);
    state.postMessage({ command: 'changeSummary', changeSummary: summaryItems });
  } else {
    state.postMessage({ command: 'changeSummary', changeSummary: [] });
  }
}

export async function handleAcceptAllChanges(state: ChatState): Promise<void> {
  state.changelog.clear();

  // In audit mode the agent's writes are buffered, not in state.changelog.
  // Flush them now so "Accept All" in the change-summary panel covers both
  // the changelog entries (just cleared) and any audit-buffered writes.
  const { getDefaultAuditBuffer } = await import('../../agent/audit/auditBuffer.js');
  const buf = getDefaultAuditBuffer();
  if (!buf.isEmpty) {
    const folders = workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const rootUri = folders[0].uri;
      const writeDisk = async (relPath: string, content: string): Promise<void> => {
        const fileUri = Uri.joinPath(rootUri, relPath);
        const dir = path.dirname(relPath);
        if (dir && dir !== '.') await workspace.fs.createDirectory(Uri.joinPath(rootUri, dir));
        await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
      };
      const deleteDisk = async (relPath: string): Promise<void> => {
        await workspace.fs.delete(Uri.joinPath(rootUri, relPath), { useTrash: true });
      };
      try {
        await buf.flush(writeDisk, deleteDisk);
      } catch {
        // Flush errors surface via the audit review UI; don't block the changelog clear.
      }
    }
  }

  state.postMessage({
    command: 'assistantMessage',
    content: '\n\n✓ All changes accepted',
  });
}

/**
 * Revert a single file that was written by the edit plan.
 *
 * op === 'create' → the file was new; trash it.
 * op === 'edit' | 'delete' → restore the HEAD version via git checkout.
 *
 * `filePath` is the workspace-relative path sent from the webview.
 */
export async function revertEditPlanFile(filePath: string, op: 'create' | 'edit' | 'delete'): Promise<void> {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  const rootUri = folders[0].uri;
  const fileUri = Uri.joinPath(rootUri, filePath);
  if (!isWithinRoot(fileUri, rootUri)) return;

  if (op === 'create') {
    try {
      await workspace.fs.delete(fileUri, { useTrash: true });
    } catch {
      // File may already be gone.
    }
    return;
  }

  // Restore HEAD content via git checkout using ShellSession so the
  // same hardening (alias/function namespace reset) applies as for all
  // agent-originated shell commands.
  const cwd = rootUri.fsPath;
  const session = new ShellSession(cwd);
  try {
    await session.execute(`git checkout HEAD -- ${JSON.stringify(filePath)}`, { timeout: 10_000 });
  } finally {
    session.dispose();
  }
}

/**
 * Gather workspace files for @-mention completion in the chat input.
 * Returns up to 500 relative paths (node_modules and hidden dirs excluded).
 * Results are sent once and cached in the webview for the session.
 */
export async function handleRequestFileCompletion(state: ChatState): Promise<void> {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    state.postMessage({ command: 'fileCompletionList', completionFiles: [] });
    return;
  }

  const root = folders[0].uri;
  const uris = await workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.sidecar/**}', 500);

  const completionFiles = uris
    .map((u) => {
      const rel = u.fsPath.startsWith(root.fsPath) ? u.fsPath.slice(root.fsPath.length + 1) : u.fsPath;
      return rel.replace(/\\/g, '/');
    })
    .sort();

  state.postMessage({ command: 'fileCompletionList', completionFiles });
}
