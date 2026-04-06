import { window, workspace } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { scanContent, formatIssues, type SecurityIssue } from './securityScanner.js';

const execAsync = promisify(exec);

/**
 * Get list of staged file paths from git.
 */
async function getStagedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git diff --cached --name-only --diff-filter=ACM', {
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
export async function scanStagedFiles(): Promise<{ issues: SecurityIssue[]; scannedCount: number }> {
  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return { issues: [], scannedCount: 0 };

  const stagedFiles = await getStagedFiles(cwd);
  if (stagedFiles.length === 0) return { issues: [], scannedCount: 0 };

  const allIssues: SecurityIssue[] = [];

  for (const filePath of stagedFiles) {
    try {
      // Read the staged version of the file (not the working copy)
      const { stdout } = await execAsync(`git show ":${filePath}"`, {
        cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const issues = scanContent(stdout, filePath);
      allIssues.push(...issues);
    } catch {
      // File might be binary or too large — skip
    }
  }

  return { issues: allIssues, scannedCount: stagedFiles.length };
}

/**
 * Run the pre-commit scan and show results to the user.
 * Returns true if clean, false if issues found.
 */
export async function runPreCommitScan(): Promise<boolean> {
  const { issues, scannedCount } = await scanStagedFiles();

  if (scannedCount === 0) {
    window.showInformationMessage('No staged files to scan.');
    return true;
  }

  const secrets = issues.filter((i) => i.category === 'secret');
  const vulnerabilities = issues.filter((i) => i.category === 'vulnerability');

  if (issues.length === 0) {
    window.showInformationMessage(`Security scan passed: ${scannedCount} staged file(s) clean.`);
    return true;
  }

  const formatted = formatIssues(issues);
  const doc = await workspace.openTextDocument({
    content:
      `# SideCar Security Scan — Staged Files\n\n` +
      `Scanned ${scannedCount} file(s). Found **${secrets.length} secret(s)** and **${vulnerabilities.length} vulnerability warning(s)**.\n\n` +
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
