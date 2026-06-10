import * as fs from 'fs';
import * as path from 'path';
import { window, workspace, commands, ProgressLocation, Uri, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { ShellSession } from '../terminal/shellSession.js';
import type { ExtensionMessage } from '../webview/chatWebview.js';
import type { ChatViewProvider } from '../webview/chatView.js';

interface EvalItem {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

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

// Parse a vitest output line (ANSI already stripped by ShellSession) for a case result.
// Lines look like:
//   " ✓ tests/.../agent.eval.ts > llm-eval :: agent loop > read-single-file — Agent reads... 46858ms"
//   " × tests/.../agent.eval.ts > llm-eval :: agent loop > ask-user-ambiguous-rename — ..."
function parseVitestLine(line: string): { caseId: string; passed: boolean } | null {
  const passMatch = line.match(/✓[^>]*>[^>]*>\s*([^—]+)\s*—/);
  const failMatch = line.match(/[×✕][^>]*>[^>]*>\s*([^—]+)\s*—/);
  const m = passMatch ?? failMatch;
  if (!m) return null;
  return { caseId: m[1].trim(), passed: !!passMatch };
}

export function registerTestModelCommand(
  context: ExtensionContext,
  getChatProvider: () => ChatViewProvider | undefined,
): void {
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

      const chatProvider = getChatProvider();
      const items: EvalItem[] = [];
      let doneCount = 0;
      let currentRunningId: string | null = null;

      function postEvalProgress(done = false): void {
        if (!chatProvider) return;
        const msg: ExtensionMessage = {
          command: 'batchProgress',
          batchProgress: {
            kind: 'eval',
            task: `Smoke eval — ${modelLabel}`,
            items: items.map((i) => ({ ...i })),
            doneCount: done ? items.length : doneCount,
            totalCount: items.length || 8,
          },
        };
        chatProvider.notify(msg);
      }

      function handleOutput(chunk: string): void {
        for (const line of chunk.split('\n')) {
          const result = parseVitestLine(line);
          if (!result) continue;

          const { caseId, passed } = result;
          const existing = items.find((i) => i.id === caseId);
          if (existing) {
            existing.status = passed ? 'done' : 'error';
            if (existing.id === currentRunningId) currentRunningId = null;
          } else {
            items.push({ id: caseId, label: caseId, status: passed ? 'done' : 'error' });
          }
          doneCount++;

          // Mark the next pending case as running, if any.
          const nextPending = items.find((i) => i.status === 'pending');
          if (nextPending) {
            nextPending.status = 'running';
            currentRunningId = nextPending.id;
          }

          postEvalProgress();
        }
      }

      // Show the panel immediately with a placeholder running item.
      if (chatProvider) {
        items.push({ id: 'starting…', label: 'starting…', status: 'running' });
        postEvalProgress();
      }

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `SideCar — Testing model: ${modelLabel}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Running smoke eval suite (~10 min)…' });

          // Remove placeholder once real output starts.
          let placeholderRemoved = false;
          const shell = new ShellSession(cwd);
          await shell.execute('SIDECAR_EVAL_TAGS=smoke npm run eval:llm 2>&1', {
            timeout: 15 * 60 * 1000,
            onOutput: (chunk: string) => {
              if (!placeholderRemoved && chunk.trim()) {
                const idx = items.findIndex((i) => i.id === 'starting…');
                if (idx !== -1) items.splice(idx, 1);
                placeholderRemoved = true;
              }
              handleOutput(chunk);
              const done = items.filter((i) => i.status === 'done' || i.status === 'error').length;
              progress.report({ message: `${done} / ${Math.max(items.length, 8)} cases…` });
            },
          });
        },
      );

      // Final update — clear any leftover running state.
      for (const item of items) {
        if (item.status === 'running') item.status = 'pending';
      }
      postEvalProgress(true);

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
