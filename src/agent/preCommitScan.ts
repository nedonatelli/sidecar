import { window, workspace } from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { scanContent, formatIssues, isScanSkipped, type SecurityIssue } from './securityScanner.js';

const execFileAsync = promisify(execFile);

/**
 * Get list of staged file paths from git.
 */
async function getStagedFiles(cwd: string): Promise<string[]> {
  try {
    // R: a renamed file's content is new to this commit as much as an added one.
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd,
      timeout: 10_000,
    });
    return stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Scan all staged files for secrets and vulnerabilities.
 * Returns the list of issues found.
 */
export async function scanStagedFiles(): Promise<{
  issues: SecurityIssue[];
  scannedCount: number;
  /** Staged files that were NOT scanned (excluded, unreadable, too large). */
  unscanned: string[];
}> {
  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return { issues: [], scannedCount: 0, unscanned: [] };

  const stagedFiles = await getStagedFiles(cwd);
  if (stagedFiles.length === 0) return { issues: [], scannedCount: 0, unscanned: [] };

  const allIssues: SecurityIssue[] = [];
  const unscanned: string[] = [];
  let scannedCount = 0;

  for (const filePath of stagedFiles) {
    if (isScanSkipped(filePath)) {
      unscanned.push(filePath);
      continue;
    }
    try {
      // Read the staged version of the file (not the working copy).
      // Use execFile (no shell) so filenames with spaces or special chars
      // don't become shell metacharacters.
      const { stdout } = await execFileAsync('git', ['show', `:${filePath}`], {
        cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const issues = scanContent(stdout, filePath);
      allIssues.push(...issues);
      scannedCount++;
    } catch {
      // Binary, too large, or unreadable: NOT scanned, and reported as such.
      unscanned.push(filePath);
    }
  }

  return { issues: allIssues, scannedCount, unscanned };
}

/**
 * Run the pre-commit scan and show results to the user.
 * Returns true if clean, false if issues found.
 */
export async function runPreCommitScan(): Promise<boolean> {
  const { issues, scannedCount, unscanned } = await scanStagedFiles();

  if (scannedCount === 0 && unscanned.length === 0) {
    window.showInformationMessage('No staged files to scan.');
    return true;
  }
  // A file that was not scanned is not clean. Say which ones.
  const unscannedNote =
    unscanned.length > 0
      ? ` ${unscanned.length} staged file(s) could not be scanned: ${unscanned.slice(0, 5).join(', ')}${unscanned.length > 5 ? ', …' : ''}.`
      : '';

  const secrets = issues.filter((i) => i.category === 'secret');
  const vulnerabilities = issues.filter((i) => i.category === 'vulnerability');

  if (issues.length === 0) {
    if (unscanned.length > 0) {
      window.showWarningMessage(`Security scan: ${scannedCount} staged file(s) clean.${unscannedNote}`);
      return false;
    }
    window.showInformationMessage(`Security scan passed: ${scannedCount} staged file(s) clean.`);
    return true;
  }

  const formatted = formatIssues(issues);
  const doc = await workspace.openTextDocument({
    content:
      `# SideCar Security Scan — Staged Files\n\n` +
      `Scanned ${scannedCount} file(s). Found **${secrets.length} secret(s)** and **${vulnerabilities.length} vulnerability warning(s)**.${unscannedNote}\n\n` +
      `## Issues\n\n\`\`\`\n${formatted}\n\`\`\`\n\n` +
      `> Fix these issues before committing. Secrets in version control are a security risk.`,
    language: 'markdown',
  });
  await window.showTextDocument(doc, { preview: true });

  if (secrets.length > 0) {
    window.showWarningMessage(
      `SideCar found ${secrets.length} potential secret(s) in staged files. Review before committing.`,
    );
  }

  return false;
}
