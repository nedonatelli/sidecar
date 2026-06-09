import * as fs from 'fs';
import * as path from 'path';
import { window, workspace, commands, ProgressLocation, Uri, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { ShellSession } from '../terminal/shellSession.js';

function parsePassRate(report: string): { passed: number; total: number } | null {
  // Matches lines like: **✅ 7 / 8 passed** or **❌ 5 / 8 passed**
  const match = report.match(/\*\*[✅❌]\s+(\d+)\s*\/\s*(\d+)\s+passed\*\*/g);
  if (!match) return null;
  let passed = 0;
  let total = 0;
  for (const m of match) {
    const nums = m.match(/(\d+)\s*\/\s*(\d+)/);
    if (nums) {
      passed += parseInt(nums[1], 10);
      total += parseInt(nums[2], 10);
    }
  }
  return total > 0 ? { passed, total } : null;
}

export function registerTestModelCommand(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('sidecar.testCurrentModel', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        void window.showErrorMessage('SideCar: No workspace folder open.');
        return;
      }

      const cwd = wsFolder.uri.fsPath;
      const reportPath = path.join(cwd, 'eval-failures.md');
      const cfg = getConfig();
      const modelLabel = cfg.model || 'current model';

      // Clean up stale report from a prior run.
      try {
        fs.unlinkSync(reportPath);
      } catch {
        // Fine if it didn't exist.
      }

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `SideCar — Testing model: ${modelLabel}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Running smoke eval suite (~10 min)…' });

          const shell = new ShellSession(cwd);
          // 15 minutes — smoke suite is ~8 cases × ~90 s each.
          await shell.execute('SIDECAR_EVAL_TAGS=smoke npm run eval:llm 2>&1', {
            timeout: 15 * 60 * 1000,
          });
        },
      );

      // Read the report the eval suite wrote.
      let report = '';
      try {
        report = fs.readFileSync(reportPath, 'utf8');
      } catch {
        // Eval may not have written one (e.g. no backend, all skipped).
      }

      const stats = parsePassRate(report);
      if (!stats) {
        // No stats = backend unavailable or all skipped.
        void window.showWarningMessage(
          'SideCar model test: no results — check that Ollama is running or an API key is configured.',
        );
        return;
      }

      const allPassed = stats.passed === stats.total;
      const label = `${stats.passed} / ${stats.total} smoke cases passed`;

      if (allPassed) {
        void window.showInformationMessage(`SideCar model test: ✅ ${label} — ${modelLabel} looks good.`);
      } else {
        const choice = await window.showWarningMessage(
          `SideCar model test: ❌ ${label} — ${modelLabel} had failures.`,
          'Open Report',
          'Dismiss',
        );
        if (choice === 'Open Report') {
          void commands.executeCommand('vscode.open', Uri.file(reportPath));
        }
      }
    }),
  );
}
