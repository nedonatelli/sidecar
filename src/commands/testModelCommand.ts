import * as fs from 'fs';
import * as path from 'path';
import { window, workspace, commands, ProgressLocation, Uri, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { ShellSession } from '../terminal/shellSession.js';
import type { EvalTreeProvider } from '../views/evalView.js';

// Number of smoke-tagged cases — used to pre-populate placeholder slots.
const SMOKE_CASE_COUNT = 8;

function parsePassRate(report: string): { passed: number; total: number } | null {
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

// Parse a stripped vitest output line for a case result.
// Lines look like:
//   " ✓ tests/.../agent.eval.ts > llm-eval :: agent loop > read-single-file — Agent reads..."
//   " × tests/.../agent.eval.ts > llm-eval :: agent loop > ask-user-ambiguous-rename — ..."
function parseVitestLine(line: string): { caseId: string; passed: boolean } | null {
  const passMatch = line.match(/✓[^>]*>[^>]*>\s*([^—]+)\s*—/);
  const failMatch = line.match(/[×✕][^>]*>[^>]*>\s*([^—]+)\s*—/);
  const m = passMatch ?? failMatch;
  if (!m) return null;
  return { caseId: m[1].trim(), passed: !!passMatch };
}

export function registerTestModelCommand(context: ExtensionContext, getEvalProvider: () => EvalTreeProvider): void {
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

      try {
        fs.unlinkSync(reportPath);
      } catch {
        // Fine if it didn't exist.
      }

      const evalProvider = getEvalProvider();
      evalProvider.start(modelLabel, SMOKE_CASE_COUNT);

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `SideCar — Testing model: ${modelLabel}`,
          cancellable: false,
        },
        async (progress) => {
          let doneCount = 0;
          progress.report({ message: `0 / ${SMOKE_CASE_COUNT} cases…` });

          const shell = new ShellSession(cwd);
          await shell.execute('SIDECAR_EVAL_TAGS=smoke npm run eval:llm 2>&1', {
            timeout: 15 * 60 * 1000,
            onOutput: (chunk: string) => {
              for (const line of chunk.split('\n')) {
                const result = parseVitestLine(line);
                if (!result) continue;
                evalProvider.updateCase(result.caseId, result.passed ? 'passed' : 'failed');
                doneCount++;
                progress.report({ message: `${doneCount} / ${SMOKE_CASE_COUNT} cases…` });
              }
            },
          });
        },
      );

      evalProvider.finish(reportPath);

      let report = '';
      try {
        report = fs.readFileSync(reportPath, 'utf8');
      } catch {
        // Eval may not have written one (e.g. no backend, all skipped).
      }

      const stats = parsePassRate(report);
      if (!stats) {
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
