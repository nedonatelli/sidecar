import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// DOGFOOD — the real agent loop, in a real extension host, against a real model.
//
// Everything built over the last two days was verified by unit tests, probes and
// evals. None of it has been RUN: the audit log's newest entry predates all of
// it. That is the largest remaining verification hole, and the paths that most
// need it are exactly the ones a mocked test cannot reach —
//
//   • get_diagnostics now opens a preview tab, waits for the language server,
//     and closes the tab it opened. Nothing outside a real editor exercises it.
//   • edit_file's tolerant matcher and the removal of insert_* change what the
//     model can express. Only a model can tell us whether that works.
//   • run_command redirects stdin from /dev/null now. A real shell, please.
//
// SAFETY. The extension-development host opens THIS repository as its
// workspace, and this test drives an autonomous agent with write access. It is
// therefore scoped to a gitignored scratch directory created per run and
// removed afterwards. The agent is told to work only there; the assertions
// check that nothing outside it changed. A dogfood test that could rewrite the
// repo it is testing would be an unacceptable trade.

const SCRATCH = 'dogfood-tmp';

function scratchPath(...p: string[]): string {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  return path.join(root, SCRATCH, ...p);
}

/** Snapshot of tracked-file mtimes outside the scratch dir, to prove no stray writes. */
function snapshotRepo(): Map<string, number> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const seen = new Map<string, number>();
  for (const dir of ['src/agent/tools', 'src/config', 'scripts']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      const p = path.join(abs, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) seen.set(p, st.mtimeMs);
      } catch {
        /* raced */
      }
    }
  }
  return seen;
}

suite('dogfood — real agent loop in a real extension host', function () {
  let repoBefore: Map<string, number>;

  suiteSetup(() => {
    fs.mkdirSync(scratchPath(), { recursive: true });
    repoBefore = snapshotRepo();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(scratchPath(), { recursive: true, force: true });
  });

  test('get_diagnostics reports a real type error and leaves the editor as it found it', async function () {
    this.timeout(120_000);
    // The change with the least coverage: on-demand analysis via a preview tab.
    // Unit tests cannot reach it; the probe proved the mechanism; this proves it
    // through the TOOL, in the host, on a file created the way an agent creates
    // files.
    // The file must live inside a TypeScript PROJECT. tsserver only analyses
    // files a tsconfig includes, so a scratch dir at the repo root gets nothing
    // no matter how many tabs we open — a real constraint the probe missed
    // because its fixture happened to sit in src/test/integration.
    const rel = 'src/test/integration/__dogfood_broken__.ts';
    const abs = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, rel);
    fs.writeFileSync(abs, 'export const wrong: number = "not a number";\n', 'utf-8');

    const mod = require(
      path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'out/agent/tools/diagnostics.js'),
    ) as {
      getDiagnostics: (i: unknown, c?: unknown) => Promise<string>;
    };
    const tabsBefore = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    const out = await mod.getDiagnostics({ path: rel });
    const ourTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => (t.input as vscode.TabInputText | undefined)?.uri?.fsPath === abs);

    console.log(`\n=== get_diagnostics on an agent-written file ===\n${out}`);
    console.log(
      `tabs before=${tabsBefore} ours-left-open=${ourTabs.length} focus=${vscode.window.activeTextEditor?.document.fileName ?? 'none'}`,
    );

    assert.ok(/not assignable/.test(out), `expected a real type error, got:\n${out}`);
    assert.strictEqual(ourTabs.length, 0, 'the tool must close the tab it opened');
    assert.strictEqual(vscode.window.activeTextEditor, undefined, 'focus must not move');
    fs.rmSync(abs, { force: true });
  });

  test('when it cannot analyse, it says so rather than reporting clean', async function () {
    this.timeout(60_000);
    // The safety property the whole get_diagnostics rework rests on: an empty
    // result must never read as "clean". Forced deterministically with a zero
    // budget, because the natural trigger — a COLD TypeScript server missing
    // the 5s window — is timing-dependent and cannot be relied on in a test.
    // (Files outside any tsconfig are NOT a trigger: tsserver builds inferred
    // projects for them and diagnoses them fine. Measured, after assuming
    // otherwise.)
    const rel = `${SCRATCH}/outside.ts`;
    fs.writeFileSync(scratchPath('outside.ts'), 'export const alsoWrong: number = "nope";\n', 'utf-8');
    const mod = require(
      path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'out/agent/tools/diagnostics.js'),
    ) as { getDiagnostics: (i: unknown, c?: unknown) => Promise<string> };
    const out = await mod.getDiagnostics({ path: rel }, { config: { diagnosticsAnalysisBudgetMs: 0 } });
    console.log(`\n=== get_diagnostics with analysis disabled ===\n${out}`);
    assert.ok(/NOT proof/.test(out), `expected the not-proof caveat, got:\n${out}`);
  });

  test('run_command does not let a stdin-reading command eat the sentinel', async function () {
    this.timeout(120_000);
    // Yesterday `cat` returned `echo "` as its stdout and a fabricated exit 0,
    // and a heredoc HUNG until the timeout. Both through the real tool now.
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const mod = require(path.join(root, 'out/agent/tools/shell.js')) as {
      runCommand: (i: unknown, c?: unknown) => Promise<string>;
    };

    // Which path actually runs? The composite executor prefers the VS Code
    // terminal when shell integration attaches, and falls back to ShellSession
    // otherwise. Assuming instead of measuring is how the last three
    // diagnoses went wrong.
    const { guardStdin } = require(path.join(root, 'out/terminal/agentExecutor.js')) as {
      guardStdin: (c: string, s?: string) => string;
    };
    console.log(`\n=== env.shell = ${JSON.stringify(vscode.env.shell)}`);
    console.log(`=== guardStdin('cat') -> ${JSON.stringify(guardStdin('cat'))}`);
    const term = vscode.window.terminals.find((t) => t.name.includes('SideCar'));
    console.log(`=== sidecar terminal present=${!!term} shellIntegration=${!!term?.shellIntegration}`);

    const catOut = await Promise.race([
      mod.runCommand({ command: 'cat' }),
      new Promise<string>((r) => setTimeout(() => r('__TIMED_OUT_AFTER_20s__'), 20_000)),
    ]);
    console.log(`\n=== run_command "cat" ===\n${catOut.slice(0, 200)}`);
    assert.ok(!/echo\s*"/.test(catOut), `sentinel leaked into output:\n${catOut}`);

    const heredoc = await mod.runCommand({ command: `cat <<'EOF'\nalpha\nbravo\nEOF` });
    console.log(`=== run_command heredoc ===\n${heredoc.slice(0, 200)}`);
    assert.ok(/alpha/.test(heredoc) && /bravo/.test(heredoc), `heredoc did not work:\n${heredoc}`);
  });

  test('edit_file adds code to an existing file through the real tool', async function () {
    this.timeout(120_000);
    // insert_* is gone; adding code means repeating the anchor in `replace`.
    // This is the contract the removal rests on, exercised on real bytes.
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const mod = require(path.join(root, 'out/agent/tools/fs.js')) as {
      editFile: (i: unknown, c?: unknown) => Promise<string>;
    };
    const rel = `${SCRATCH}/calc.py`;
    fs.writeFileSync(scratchPath('calc.py'), 'def add(a, b):\n    return a + b\n', 'utf-8');

    const res = await mod.editFile({
      path: rel,
      search: 'def add(a, b):\n    return a + b',
      replace: 'def add(a, b):\n    return a + b\n\ndef multiply(a, b):\n    return a * b',
    });
    const after = fs.readFileSync(scratchPath('calc.py'), 'utf-8');
    console.log(`\n=== edit_file add-alongside ===\n${res}\n--- file now:\n${after}`);
    assert.ok(/File edited/.test(res), res);
    assert.ok(after.includes('def add') && after.includes('def multiply'), `anchor lost:\n${after}`);
  });

  test('nothing outside the scratch directory was modified', () => {
    const after = snapshotRepo();
    const changed: string[] = [];
    for (const [p, mtime] of after) {
      const before = repoBefore.get(p);
      if (before === undefined || before !== mtime) changed.push(path.relative(process.cwd(), p));
    }
    assert.deepStrictEqual(changed, [], `dogfood run modified files outside ${SCRATCH}: ${changed.join(', ')}`);
  });
});
