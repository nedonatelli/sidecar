import { languages, commands, window, Selection, Position, type ExtensionContext } from 'vscode';
import { SidecarCodeLensProvider, findSymbolEnd, type CodeLensArgs } from '../codelens/sidecarCodeLensProvider.js';
import type { ChatViewProvider } from '../webview/chatView.js';

const REFACTOR_OPTIONS = [
  { label: 'Extract function', description: 'Pull duplicated or complex logic into a named helper' },
  { label: 'Add type annotations', description: 'Tighten parameter and return types' },
  { label: 'Convert to async/await', description: 'Replace .then()/.catch() chains with async/await' },
  { label: 'Improve error handling', description: 'Add proper try/catch, error types, or recovery logic' },
  { label: 'Add JSDoc comment', description: 'Generate a JSDoc/docstring from the implementation' },
  { label: 'Reduce complexity', description: 'Simplify deeply nested conditionals or loops' },
  { label: 'Custom refactor…', description: 'Describe what you want changed' },
] as const;

export function initCodeLens(context: ExtensionContext, getChatProvider: () => ChatViewProvider | undefined): void {
  const provider = new SidecarCodeLensProvider();
  const langs = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'go', 'rust'];

  context.subscriptions.push(
    ...langs.map((lang) => languages.registerCodeLensProvider({ language: lang, scheme: 'file' }, provider)),

    commands.registerCommand('sidecar.codelens.invoke', async (args: CodeLensArgs) => {
      const editor = window.activeTextEditor;
      if (!editor) return;

      const { startLine, action } = args;
      const endLine = findSymbolEnd(editor.document, startLine);

      // Select the symbol body so every action has focused context.
      const start = new Position(startLine, 0);
      const end = editor.document.lineAt(Math.min(endLine, editor.document.lineCount - 1)).range.end;
      editor.selection = new Selection(start, end);

      switch (action) {
        case 'explain':
          await commands.executeCommand('sidecar.explainSelection');
          break;

        case 'fix':
          await commands.executeCommand('sidecar.fixSelection');
          break;

        case 'addTests': {
          const chatProvider = getChatProvider();
          if (!chatProvider) {
            window.showErrorMessage('SideCar: chat view is not ready yet.');
            return;
          }
          const selectionText = editor.document.getText(editor.selection);
          const lang = editor.document.languageId;
          chatProvider.injectPrompt(
            `Add unit tests for the following ${lang} code. Use the project's existing test framework and file conventions.\n\n\`\`\`${lang}\n${selectionText}\n\`\`\``,
          );
          break;
        }

        case 'refactor': {
          const pick = await window.showQuickPick(REFACTOR_OPTIONS, {
            title: 'SideCar: Refactor — choose a direction',
            placeHolder: 'What kind of refactor?',
          });
          if (!pick) return;

          let instruction: string = pick.label;
          if (pick.label === 'Custom refactor…') {
            const custom = await window.showInputBox({
              prompt: 'Describe the refactor',
              placeHolder: 'e.g. "split this into two smaller functions"',
            });
            if (!custom?.trim()) return;
            instruction = custom.trim();
          }

          const chatProvider = getChatProvider();
          if (!chatProvider) {
            window.showErrorMessage('SideCar: chat view is not ready yet.');
            return;
          }
          const selectionText = editor.document.getText(editor.selection);
          const lang = editor.document.languageId;
          chatProvider.injectPrompt(
            `Refactor the following ${lang} code: ${instruction}.\n\n\`\`\`${lang}\n${selectionText}\n\`\`\``,
          );
          break;
        }
      }
    }),
  );
}
