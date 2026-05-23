import { languages, commands, window, Selection, Position, type ExtensionContext } from 'vscode';
import { SidecarCodeLensProvider } from '../codelens/sidecarCodeLensProvider.js';

export function initCodeLens(context: ExtensionContext): void {
  const provider = new SidecarCodeLensProvider();
  const langs = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'go', 'rust'];

  context.subscriptions.push(
    ...langs.map((lang) => languages.registerCodeLensProvider({ language: lang, scheme: 'file' }, provider)),
    commands.registerCommand(
      'sidecar.codelens.invoke',
      (args: { startLine: number; endLine: number; action: 'explain' | 'fix' }) => {
        const editor = window.activeTextEditor;
        if (!editor) return;
        const start = new Position(args.startLine, 0);
        const endLine = editor.document.lineAt(Math.min(args.endLine, editor.document.lineCount - 1));
        editor.selection = new Selection(start, endLine.range.end);
        const cmd = args.action === 'fix' ? 'sidecar.fixSelection' : 'sidecar.explainSelection';
        void commands.executeCommand(cmd);
      },
    ),
  );
}
