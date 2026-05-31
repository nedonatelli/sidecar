// ---------------------------------------------------------------------------
// Skill Publish — write a local skill file into the user's git registry,
// commit it, and push. Surfaced via:
//
//   • `SideCar: Publish Skill to Registry` command palette entry
//   • Post-creation hook in the create-skill agent flow (agent calls
//     `sidecar.skills.publish` with a pre-filled filePath)
//
// Requires `sidecar.skills.userRegistry` to point to a git remote that is
// already cloned into ~/.sidecar/user-skills/ (syncSkillRegistries does
// this on activation). Refuses to operate when offline mode is on.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { getConfig } from '../config/settings.js';
import { GitCLI } from '../github/git.js';
import type { SkillLoader } from '../agent/skillLoader.js';

export interface PublishSkillOptions {
  /** Absolute path of the skill .md file to publish. When omitted a file picker opens. */
  filePath?: string;
  /** Override the clone directory (for tests). Defaults to ~/.sidecar/user-skills/. */
  registryDir?: string;
  /** Override git client (for tests). */
  git?: GitCLI;
  /** Override home directory (for tests). Defaults to os.homedir(). */
  homeDir?: string;
}

/**
 * Copy `filePath` into the user registry clone, commit, and push.
 * Returns `true` on success, `false` if the user cancelled or an error occurred.
 */
export async function publishSkill(opts: PublishSkillOptions = {}): Promise<boolean> {
  const cfg = getConfig();

  if (cfg.skillsOffline) {
    void vscode.window.showWarningMessage(
      'SideCar: Skill publish is disabled while offline mode is active (sidecar.skills.offline).',
    );
    return false;
  }

  if (!cfg.skillsUserRegistry.trim()) {
    const choice = await vscode.window.showWarningMessage(
      'SideCar: No user registry configured. Set sidecar.skills.userRegistry to a git URL to enable skill publishing.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'sidecar.skills.userRegistry');
    }
    return false;
  }

  const homeDir = opts.homeDir ?? os.homedir();
  const registryDir = opts.registryDir ?? path.join(homeDir, '.sidecar', 'user-skills');

  // Verify the registry clone exists
  const cloneExists = await fs.promises.access(registryDir).then(
    () => true,
    () => false,
  );
  if (!cloneExists) {
    void vscode.window.showWarningMessage(
      `SideCar: Registry clone not found at ${registryDir}. Run "SideCar: Sync Skill Registries" first.`,
    );
    return false;
  }

  // Resolve source file
  let sourcePath = opts.filePath;
  if (!sourcePath) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Skill files': ['md'] },
      title: 'Select skill file to publish',
    });
    if (!uris || uris.length === 0) return false;
    sourcePath = uris[0].fsPath;
  }

  // Guard against path traversal: only allow .md files inside known skill directories.
  const absSource = path.resolve(sourcePath);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const allowedRoots = [
    path.join(homeDir, '.claude', 'commands'),
    path.join(homeDir, '.sidecar'),
    ...(workspaceRoot
      ? [path.join(workspaceRoot, '.claude', 'commands'), path.join(workspaceRoot, '.sidecar', 'skills')]
      : []),
  ];
  const inAllowedRoot = allowedRoots.some((r) => absSource.startsWith(r + path.sep) || absSource === r);
  if (!inAllowedRoot || path.extname(absSource) !== '.md') {
    void vscode.window.showErrorMessage(
      'SideCar: Skill publish blocked — file must be a .md file inside a known skills directory ' +
        '(~/.claude/commands/, ~/.sidecar/, or the workspace .sidecar/skills/).',
    );
    return false;
  }

  const fileName = path.basename(absSource).replace(/[\r\n]/g, '_');
  const destPath = path.join(registryDir, fileName);

  // Warn on overwrite
  const destExists = await fs.promises.access(destPath).then(
    () => true,
    () => false,
  );
  if (destExists) {
    const choice = await vscode.window.showWarningMessage(
      `SideCar: "${fileName}" already exists in your registry. Overwrite it?`,
      { modal: true },
      'Overwrite',
    );
    if (choice !== 'Overwrite') return false;
  }

  try {
    const content = await fs.promises.readFile(absSource, 'utf-8');
    await fs.promises.writeFile(destPath, content, 'utf-8');

    const git = opts.git ?? new GitCLI(registryDir);
    try {
      await git.stage([destPath]);
      await git.commit(`Add skill: ${fileName.replace(/\.md$/, '')}`);
      await git.push();
    } catch (gitErr) {
      // Roll back the written file so the registry clone stays clean.
      await fs.promises.unlink(destPath).catch(() => {});
      throw gitErr;
    }

    void vscode.window.showInformationMessage(`SideCar: Published "${fileName}" to your skill registry.`);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `SideCar: Failed to publish skill: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Command handler for `sidecar.skills.publish`. Resolves the file to
 * publish from the active editor or a file picker, then delegates to
 * `publishSkill`. The `skillLoader` parameter is accepted but not used
 * (kept for a future "pick from loaded skills" flow).
 */
export async function runSkillPublishCommand(_skillLoader: SkillLoader): Promise<void> {
  // Pre-fill with the active editor if it looks like a skill file
  const activeEditor = vscode.window.activeTextEditor;
  const preFilledPath =
    activeEditor &&
    activeEditor.document.fileName.endsWith('.md') &&
    (activeEditor.document.fileName.includes('skills') || activeEditor.document.fileName.includes('commands'))
      ? activeEditor.document.fileName
      : undefined;

  await publishSkill({ filePath: preFilledPath });
}
