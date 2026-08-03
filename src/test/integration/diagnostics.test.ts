import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Integration tests for `get_diagnostics` against a real extension host.
//
// This file was 650 lines and 20 tests, 16 of which asserted nothing — a probe
// suite written to answer "what actually produces diagnostics in a dev host?",
// because `languages.getDiagnostics(uri)` returned "No diagnostics" in 30 of 33
// real dogfood calls. The probes answered it. Their findings are recorded as a
// measurement table in src/agent/tools/diagnostics.ts, next to the code that
// depends on them, and the probes themselves are gone per CONTRIBUTING's
// debugging methodology: read the numbers, then revert the instrumentation.
//
// What remains asserts. An assertion-free test in a suite is indistinguishable
// from a passing one, which is the property this repo keeps getting caught by.

const PROBE = path.join(__dirname, '__diag_probe__.ts');

/** A file with an unambiguous type error the TS language service must flag. */
const BROKEN_SOURCE = [
  'export function probeAdd(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  '// Deliberate type error: string is not assignable to number.',
  'export const probeResult: number = probeAdd(1, "two");',
  '',
  '// Deliberate unknown-symbol error.',
  'export const probeMissing = someSymbolThatDoesNotExist();',
  '',
].join('\n');

/** Poll until diagnostics appear or the budget runs out. */
async function waitForDiagnostics(uri: vscode.Uri, budgetMs: number): Promise<{ count: number; messages: string[] }> {
  const started = Date.now();
  for (;;) {
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags.length > 0) return { count: diags.length, messages: diags.map((d) => d.message) };
    if (Date.now() - started >= budgetMs) return { count: 0, messages: [] };
    await new Promise((r) => setTimeout(r, 250));
  }
}

suite('get_diagnostics — the premise the completion gate rests on', () => {
  suiteTeardown(() => {
    fs.rmSync(PROBE, { force: true });
  });

  test('an unopened file yields nothing, however broken it is', async function () {
    this.timeout(60_000);
    fs.writeFileSync(PROBE, BROKEN_SOURCE, 'utf-8');

    const result = await waitForDiagnostics(vscode.Uri.file(PROBE), 10_000);

    // The completion gate depends on this: an empty get_diagnostics result does
    // NOT satisfy the lint requirement, precisely because an unopened file
    // yields nothing no matter how broken it is. If VS Code ever starts
    // analyzing unopened files, this fails — and that is the signal to revisit
    // `diagnosticsProvedAnalysis` in completionGate.ts, because an empty result
    // would then be real evidence of a clean file.
    assert.strictEqual(
      result.count,
      0,
      `An unopened file with two deliberate type errors reported ${result.count} diagnostics ` +
        `(${result.messages.join('; ')}). The premise behind completionGate.diagnosticsProvedAnalysis ` +
        `no longer holds — revisit that gate.`,
    );
  });
});

suite('get_diagnostics tool — end to end', () => {
  const created: string[] = [];
  suiteSetup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    created.forEach((f) => fs.rmSync(f, { force: true }));
  });

  /** The tool, loaded from the built extension the same way the agent loads it. */
  async function callTool(relPath: string, ctx?: unknown): Promise<string> {
    // Loaded from the COMPILED extension. An absolute path, because the two
    // tsconfigs disagree about rootDir: this file compiles to
    // out/src/test/integration/, the extension to out/agent/, so any relative
    // literal that satisfies the type-checker is wrong at runtime.
    const modPath = path.join(
      vscode.workspace.workspaceFolders![0].uri.fsPath,
      'out',
      'agent',
      'tools',
      'diagnostics.js',
    );
    const mod = require(modPath) as { getDiagnostics: (i: unknown, c?: unknown) => Promise<string> };
    return mod.getDiagnostics({ path: relPath }, ctx);
  }

  test('reports real type errors for a file that was never opened', async function () {
    this.timeout(60_000);
    const rel = 'src/test/integration/__tool_e2e__.ts';
    const abs = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, rel);
    created.push(abs);
    fs.writeFileSync(abs, 'export const toolBad: number = "not a number";\n', 'utf-8');

    const out = await callTool(rel);

    // Count tabs FOR THIS FILE, not tabs in total: VS Code's own Welcome page
    // drifts in asynchronously during startup, and a total-count assertion
    // blames the tool for it.
    const ourTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => (t.input as vscode.TabInputText | undefined)?.uri?.fsPath === abs);

    assert.ok(/not assignable/.test(out), `expected a real type error, got:\n${out}`);
    assert.strictEqual(ourTabs.length, 0, 'the tool must close the tab it opened');
    assert.strictEqual(vscode.window.activeTextEditor, undefined, 'focus must not move');
  });

  test('a clean file is never reported as proven clean', async function () {
    this.timeout(60_000);
    const rel = 'src/test/integration/__tool_clean__.ts';
    const abs = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, rel);
    created.push(abs);
    fs.writeFileSync(abs, 'export const toolFine: number = 42;\n', 'utf-8');

    const out = await callTool(rel);

    // An unfinished analysis is indistinguishable from a clean one, so the
    // tool must never claim the latter — the caveat is the whole point.
    assert.ok(/NOT proof/.test(out), `expected the not-proof caveat, got:\n${out}`);
  });

  test('with the budget at 0 it stays invisible and says the file was not analyzed', async function () {
    this.timeout(60_000);
    const rel = 'src/test/integration/__tool_off__.ts';
    const abs = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, rel);
    created.push(abs);
    fs.writeFileSync(abs, 'export const toolOff: number = "nope";\n', 'utf-8');

    const out = await callTool(rel, { config: { diagnosticsAnalysisBudgetMs: 0 } });

    assert.ok(/NOT proof/.test(out), `expected the not-proof caveat, got:\n${out}`);
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, 0, 'budget 0 must open nothing');
  });
});
