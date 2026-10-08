import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Wait until the TypeScript server has finished loading this repository.
 *
 * get_diagnostics waits 5 s by default for a language server to analyse a
 * file. A cold tsserver on this repo takes longer than that to report anything,
 * so a test that ran early -- which one did depended on how fast the suites
 * before it finished -- got "No diagnostics reported" and failed, while the
 * same test passed on the next run. The tool says exactly that ("NOT proof the
 * file is clean"), so it is behaving as designed; the tests need a warm server.
 *
 * Opens a file with a known type error and polls until it is reported. The
 * file lives in src/test/integration because tsserver only analyses files a
 * tsconfig includes, and it is always removed, even on failure: a leftover
 * breaks the next run's compile of this directory.
 */
export async function warmTypeScriptServer(timeoutMs = 150_000): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const abs = path.join(root, 'src', 'test', 'integration', '__ts_warmup__.ts');
  fs.writeFileSync(abs, 'export const warmup: number = "not a number";\n', 'utf-8');
  try {
    const uri = vscode.Uri.file(abs);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    const deadline = Date.now() + timeoutMs;
    while (vscode.languages.getDiagnostics(uri).length === 0) {
      if (Date.now() > deadline) throw new Error(`tsserver reported nothing within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(abs, { force: true });
  }
}
