import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// DIAGNOSTIC PROBE — mostly measurement, one load-bearing assertion.
//
// `get_diagnostics` calls `languages.getDiagnostics(uri)`, and across 33 real
// dogfood calls in the audit log it returned "No diagnostics" 30 times; the
// three non-empty results all came from SideCar's own security scanner, never
// from a language server. The hypothesis is that VS Code only publishes
// diagnostics for documents a language server has ANALYZED — in practice, open
// documents — and the agent never opens the file it edits.
//
// This measures the hypothesis in a real extension host instead of arguing
// about it, and reports its own environment so a null result can be told apart
// from a broken experiment. Most of it prints rather than asserts, because the
// point is the measurement. Test A is the exception: the completion gate now
// depends on "an unopened file yields nothing", so that premise is asserted and
// will fail loudly if VS Code ever changes it.

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

/** Poll until diagnostics appear or the budget runs out; report the latency. */
async function waitForDiagnostics(
  uri: vscode.Uri,
  budgetMs: number,
): Promise<{ count: number; ms: number; messages: string[] }> {
  const started = Date.now();
  for (;;) {
    const diags = vscode.languages.getDiagnostics(uri);
    const elapsed = Date.now() - started;
    if (diags.length > 0) {
      return { count: diags.length, ms: elapsed, messages: diags.map((d) => d.message) };
    }
    if (elapsed >= budgetMs) return { count: 0, ms: elapsed, messages: [] };
    await new Promise((r) => setTimeout(r, 250));
  }
}

suite('get_diagnostics probe — what actually produces diagnostics', () => {
  suiteTeardown(() => {
    fs.rmSync(PROBE, { force: true });
  });

  test('environment: is a TypeScript language service even present?', () => {
    const ts = vscode.extensions.getExtension('vscode.typescript-language-features');
    const all = vscode.extensions.all.map((e) => e.id);
    console.log('\n===== DIAGNOSTIC PROBE :: ENVIRONMENT =====');
    console.log(`vscode version          : ${vscode.version}`);
    console.log(`workspace folder        : ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}`);
    console.log(`TS language features    : ${ts ? `present (active=${ts.isActive})` : 'ABSENT'}`);
    console.log(`total extensions loaded : ${all.length}`);
    console.log(`built-in TS-ish exts    : ${all.filter((id) => /typescript|eslint/i.test(id)).join(', ') || 'none'}`);
    // If this says ABSENT, every measurement below is meaningless and the
    // experiment — not the tool — is what needs fixing.
  });

  test('A: file on disk, never opened (what the agent actually does)', async function () {
    this.timeout(60_000);
    fs.writeFileSync(PROBE, BROKEN_SOURCE, 'utf-8');
    const uri = vscode.Uri.file(PROBE);

    const result = await waitForDiagnostics(uri, 10_000);
    console.log('\n===== A :: NOT OPENED =====');
    console.log(`diagnostics after ${result.ms}ms: ${result.count}`);
    result.messages.forEach((m) => console.log(`   - ${m}`));

    // This one ASSERTS, because the completion gate now depends on it: an empty
    // get_diagnostics result does not satisfy the lint requirement, precisely
    // because an unopened file yields nothing no matter how broken it is. If VS
    // Code ever starts analyzing unopened files, this fails — and that is the
    // signal to revisit `diagnosticsProvedAnalysis` in completionGate.ts, since
    // an empty result would then be real evidence of a clean file.
    assert.strictEqual(
      result.count,
      0,
      'An unopened file with two deliberate type errors reported diagnostics. The premise behind ' +
        'completionGate.diagnosticsProvedAnalysis no longer holds — re-run this probe and revisit that gate.',
    );
  });

  test('B: after workspace.openTextDocument (no editor shown)', async function () {
    this.timeout(60_000);
    const uri = vscode.Uri.file(PROBE);
    await vscode.workspace.openTextDocument(uri);

    const result = await waitForDiagnostics(uri, 20_000);
    console.log('\n===== B :: openTextDocument =====');
    console.log(`diagnostics after ${result.ms}ms: ${result.count}`);
    result.messages.forEach((m) => console.log(`   - ${m}`));
  });

  test('C: after showTextDocument (the file is visibly open)', async function () {
    this.timeout(60_000);
    const uri = vscode.Uri.file(PROBE);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    const result = await waitForDiagnostics(uri, 30_000);
    console.log('\n===== C :: showTextDocument =====');
    console.log(`diagnostics after ${result.ms}ms: ${result.count}`);
    result.messages.forEach((m) => console.log(`   - ${m}`));
  });

  test('D: do diagnostics survive closing the editor?', async function () {
    this.timeout(60_000);
    const uri = vscode.Uri.file(PROBE);
    const before = vscode.languages.getDiagnostics(uri).length;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((r) => setTimeout(r, 3_000));
    const after = vscode.languages.getDiagnostics(uri).length;

    console.log('\n===== D :: AFTER CLOSING =====');
    console.log(`before close: ${before}   after close: ${after}`);
    console.log(
      after === 0 && before > 0
        ? '   → diagnostics are DROPPED on close: opening is necessary AND transient'
        : '   → diagnostics persisted after close',
    );
  });

  test('E: timing — is an immediate post-edit read stale?', async function () {
    this.timeout(90_000);
    // The second-order problem: diagnostics publish asynchronously after a
    // change and get_diagnostics does not wait. Edit an ALREADY-OPEN document
    // and read immediately, the way the agent would. Poll for the SPECIFIC new
    // error — counting "any diagnostics" cannot tell fresh from stale.
    const uri = vscode.Uri.file(PROBE);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await waitForDiagnostics(uri, 30_000); // let the baseline settle
    const baseline = vscode.languages.getDiagnostics(uri).length;

    fs.writeFileSync(PROBE, `${BROKEN_SOURCE}\nexport const another: number = "also wrong";\n`, 'utf-8');
    const immediate = vscode.languages.getDiagnostics(uri).length;

    const started = Date.now();
    let fresh = immediate;
    while (Date.now() - started < 30_000) {
      fresh = vscode.languages.getDiagnostics(uri).length;
      if (fresh > baseline) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log('\n===== E :: POST-EDIT STALENESS =====');
    console.log(`baseline (settled)            : ${baseline}`);
    console.log(
      `immediately after write       : ${immediate}${immediate === baseline ? '  ← STALE: the new error is not there yet' : ''}`,
    );
    console.log(`after ${Date.now() - started}ms                  : ${fresh}`);
    console.log(
      fresh > baseline ? '   → it does catch up, but only if you wait' : '   → it NEVER caught up within 30s',
    );
  });

  test('F: showTextDocument with preserveFocus (does it work without stealing focus?)', async function () {
    this.timeout(90_000);
    // If diagnostics require a visible editor, the least intrusive version is a
    // preview tab that does not take focus. Fresh file so nothing is cached.
    const probe2 = path.join(__dirname, '__diag_probe2__.ts');
    fs.writeFileSync(probe2, 'export const bad: number = "definitely not a number";\n', 'utf-8');
    const uri = vscode.Uri.file(probe2);
    try {
      const before = await waitForDiagnostics(uri, 5_000);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
      const after = await waitForDiagnostics(uri, 30_000);

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await new Promise((r) => setTimeout(r, 2_000));
      const afterClose = vscode.languages.getDiagnostics(uri).length;

      console.log('\n===== F :: preserveFocus PREVIEW TAB =====');
      console.log(`before opening         : ${before.count}`);
      console.log(`after preview open     : ${after.count} (in ${after.ms}ms)`);
      after.messages.forEach((m) => console.log(`   - ${m}`));
      console.log(`after closing the tab  : ${afterClose}`);
    } finally {
      fs.rmSync(probe2, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND 2 — can we force a refresh instead of opening an editor?
//
// Two separate defects came out of round 1: an unopened file yields NOTHING,
// and a write underneath an open document yields STALE results for ~500ms
// because the document model syncs from disk on a watcher. Both have the same
// candidate cure: stop writing bytes behind VS Code's back and edit through the
// document API, which updates the in-memory model synchronously and notifies
// language servers directly. Whether that is enough to make a server ANALYZE a
// file it would otherwise ignore is an empirical question.
// ---------------------------------------------------------------------------

suite('get_diagnostics probe — forcing a refresh', () => {
  const files: string[] = [];
  const freshFile = (name: string, body: string): vscode.Uri => {
    const p = path.join(__dirname, name);
    fs.writeFileSync(p, body, 'utf-8');
    files.push(p);
    return vscode.Uri.file(p);
  };

  suiteSetup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    files.forEach((f) => fs.rmSync(f, { force: true }));
  });

  test('G: WorkspaceEdit on a document that is never SHOWN', async function () {
    this.timeout(60_000);
    // The whole point: if applying an edit through the document API is enough
    // to get the file analyzed, the agent never has to touch the user's editor.
    const uri = freshFile('__refresh_g__.ts', 'export const g = 1;\n');
    const doc = await vscode.workspace.openTextDocument(uri);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(1, 0), 'export const gBad: number = "not a number";\n');
    const applied = await vscode.workspace.applyEdit(edit);

    const result = await waitForDiagnostics(uri, 20_000);
    console.log('\n===== G :: applyEdit, NEVER shown =====');
    console.log(`applyEdit returned      : ${applied}`);
    console.log(`document is dirty       : ${doc.isDirty}`);
    console.log(`diagnostics after ${result.ms}ms : ${result.count}`);
    result.messages.forEach((m) => console.log(`   - ${m}`));
  });

  test('H: WorkspaceEdit + save, still never shown', async function () {
    this.timeout(60_000);
    const uri = freshFile('__refresh_h__.ts', 'export const h = 1;\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(1, 0), 'export const hBad: number = "not a number";\n');
    await vscode.workspace.applyEdit(edit);
    const saved = await doc.save();

    const result = await waitForDiagnostics(uri, 20_000);
    console.log('\n===== H :: applyEdit + save, never shown =====');
    console.log(`save() returned         : ${saved}`);
    console.log(`diagnostics after ${result.ms}ms : ${result.count}`);
    result.messages.forEach((m) => console.log(`   - ${m}`));
  });

  test('I: does the in-memory document even see a raw disk write?', async function () {
    this.timeout(60_000);
    // The staleness mechanism, isolated. If doc.getText() still shows the old
    // content after fs.writeFileSync, the language server cannot possibly be
    // reporting on the new content either.
    const uri = freshFile('__refresh_i__.ts', 'export const i = 1;\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    const before = doc.getText();

    fs.writeFileSync(uri.fsPath, 'export const i = 1;\nexport const iBad: number = "nope";\n', 'utf-8');
    const immediate = doc.getText();

    const started = Date.now();
    let settled = immediate;
    while (Date.now() - started < 15_000) {
      settled = (await vscode.workspace.openTextDocument(uri)).getText();
      if (settled !== before) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log('\n===== I :: DOC vs DISK =====');
    console.log(`doc text immediately after write matches disk : ${immediate.includes('iBad')}`);
    console.log(`doc text after ${Date.now() - started}ms matches disk : ${settled.includes('iBad')}`);
  });

  test('J: WorkspaceEdit on a SHOWN document — is the read immediately fresh?', async function () {
    this.timeout(90_000);
    // The staleness fix candidate. Same scenario as round-1 E, but the edit
    // goes through the document API instead of fs.writeFileSync.
    const uri = freshFile('__refresh_j__.ts', 'export const jBad: number = "one";\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await waitForDiagnostics(uri, 30_000);
    const baseline = vscode.languages.getDiagnostics(uri).length;

    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(1, 0), 'export const jBad2: number = "two";\n');
    await vscode.workspace.applyEdit(edit);
    const immediate = vscode.languages.getDiagnostics(uri).length;

    const started = Date.now();
    let fresh = immediate;
    while (Date.now() - started < 20_000) {
      fresh = vscode.languages.getDiagnostics(uri).length;
      if (fresh > baseline) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('\n===== J :: applyEdit on a SHOWN doc =====');
    console.log(`baseline                : ${baseline}`);
    console.log(`immediately after edit  : ${immediate}${immediate === baseline ? '  ← still stale' : '  ← FRESH'}`);
    console.log(`after ${Date.now() - started}ms              : ${fresh}`);
  });

  test('K: is onDidChangeDiagnostics a usable "it settled" signal?', async function () {
    this.timeout(60_000);
    // If we must wait, waiting on an event beats polling a fixed delay.
    const uri = freshFile('__refresh_k__.ts', 'export const k = 1;\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let fired = 0;
    let firstFireMs = -1;
    const started = Date.now();
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.fsPath === uri.fsPath)) {
        fired++;
        if (firstFireMs < 0) firstFireMs = Date.now() - started;
      }
    });

    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(1, 0), 'export const kBad: number = "nope";\n');
    await vscode.workspace.applyEdit(edit);
    await new Promise((r) => setTimeout(r, 8_000));
    sub.dispose();

    console.log('\n===== K :: onDidChangeDiagnostics =====');
    console.log(`events for this uri     : ${fired}`);
    console.log(`first event at          : ${firstFireMs}ms`);
    console.log(`final diagnostic count  : ${vscode.languages.getDiagnostics(uri).length}`);
  });
});

// ---------------------------------------------------------------------------
// ROUND 3 — can get_diagnostics do the dance ITSELF, without touching content?
//
// G proved a dirty document gets analyzed with no editor shown, but G dirtied
// it by inserting the error itself. A tool can only make a CONTENT-NEUTRAL
// touch: insert something, delete it again, leave the text byte-identical. Is
// that enough to enter the analyzed set? And can the document be returned to
// clean afterwards without a save (which would fire format-on-save and rewrite
// the user's file)?
// ---------------------------------------------------------------------------

suite('get_diagnostics probe — content-neutral refresh', () => {
  const files: string[] = [];
  const freshFile = (name: string, body: string): vscode.Uri => {
    const p = path.join(__dirname, name);
    fs.writeFileSync(p, body, 'utf-8');
    files.push(p);
    return vscode.Uri.file(p);
  };

  suiteSetup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    files.forEach((f) => fs.rmSync(f, { force: true }));
  });

  test('L: content-neutral dirty touch on a never-shown document', async function () {
    this.timeout(60_000);
    const uri = freshFile('__neutral_l__.ts', 'export const lBad: number = "not a number";\n');
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();

    const baseline = await waitForDiagnostics(uri, 4_000);

    // Insert a character, then delete exactly that character.
    const add = new vscode.WorkspaceEdit();
    add.insert(uri, new vscode.Position(0, 0), ' ');
    await vscode.workspace.applyEdit(add);
    const del = new vscode.WorkspaceEdit();
    del.delete(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)));
    await vscode.workspace.applyEdit(del);

    const result = await waitForDiagnostics(uri, 20_000);

    console.log('\n===== L :: CONTENT-NEUTRAL TOUCH =====');
    console.log(`baseline (just opened)  : ${baseline.count}`);
    console.log(`isDirty after touch     : ${doc.isDirty}`);
    console.log(`content unchanged       : ${doc.getText() === original}`);
    console.log(`on-disk unchanged       : ${fs.readFileSync(uri.fsPath, 'utf-8') === original}`);
    console.log(`diagnostics after ${result.ms}ms : ${result.count}`);
    result.messages.forEach((m) => console.log(`   - ${m}`));
    console.log(`visible editors         : ${vscode.window.visibleTextEditors.length}`);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    console.log(`tabs open               : ${tabs}${tabs > 0 ? '  ← a tab appeared for a doc we never showed' : ''}`);
  });

  test('M: can the document be returned to clean without saving?', async function () {
    this.timeout(60_000);
    const uri = vscode.Uri.file(path.join(__dirname, '__neutral_l__.ts'));
    const doc = await vscode.workspace.openTextDocument(uri);
    console.log('\n===== M :: RESTORE =====');
    console.log(`dirty before restore    : ${doc.isDirty}`);

    let reverted = false;
    try {
      await vscode.commands.executeCommand('workbench.action.files.revertResource', uri);
      reverted = true;
    } catch (err) {
      console.log(`revertResource threw    : ${(err as Error).message.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
    console.log(`revertResource ran      : ${reverted}`);
    console.log(`dirty after revert      : ${doc.isDirty}`);
    console.log(`diagnostics retained    : ${vscode.languages.getDiagnostics(uri).length}`);
  });

  test('N: does a lingering dirty doc keep its diagnostics?', async function () {
    this.timeout(60_000);
    // If restore is impossible, the fallback is leaving it dirty. Measure what
    // that costs: does the analysis survive, and is the doc visible anywhere?
    const uri = vscode.Uri.file(path.join(__dirname, '__neutral_l__.ts'));
    const doc = await vscode.workspace.openTextDocument(uri);
    console.log('\n===== N :: LINGERING STATE =====');
    console.log(`dirty                   : ${doc.isDirty}`);
    console.log(`diagnostics             : ${vscode.languages.getDiagnostics(uri).length}`);
    console.log(`visible editors         : ${vscode.window.visibleTextEditors.length}`);
    console.log(`tabs                    : ${vscode.window.tabGroups.all.flatMap((g) => g.tabs).length}`);
  });
});

// ---------------------------------------------------------------------------
// THE ACTUAL TOOL — does get_diagnostics now report on a file nobody opened?
//
// Everything above measures VS Code. This exercises SideCar's tool through its
// real entry point, which is the only thing that proves the fix works.
// ---------------------------------------------------------------------------

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

    console.log('\n===== TOOL :: never-opened file =====');
    console.log(out);
    console.log(`tabs for this file after the call: ${ourTabs.length}`);

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
    console.log('\n===== TOOL :: clean file =====');
    console.log(out);

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
    console.log('\n===== TOOL :: budget 0 =====');
    console.log(out);

    assert.ok(/NOT proof/.test(out), `expected the not-proof caveat, got:\n${out}`);
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, 0, 'budget 0 must open nothing');
  });
});

// ---------------------------------------------------------------------------
// ROUND 4 — what does the publish sequence actually look like?
//
// The first cut of the fix awaited the first onDidChangeDiagnostics event for
// the URI and then read. It reported "analyzed and clean" for a file with an
// obvious type error, so that assumption is wrong somewhere. Measure the whole
// sequence instead of reasoning about it.
// ---------------------------------------------------------------------------

suite('get_diagnostics probe — publish sequence', () => {
  const files: string[] = [];
  suiteSetup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    files.forEach((f) => fs.rmSync(f, { force: true }));
  });

  test('O: every diagnostics event for a freshly-shown broken file', async function () {
    this.timeout(60_000);
    const p = path.join(__dirname, '__seq_o__.ts');
    fs.writeFileSync(p, 'export const oBad: number = "not a number";\n', 'utf-8');
    files.push(p);
    const uri = vscode.Uri.file(p);

    const started = Date.now();
    const events: string[] = [];
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.fsPath === uri.fsPath)) {
        events.push(`  +${Date.now() - started}ms  count=${vscode.languages.getDiagnostics(uri).length}`);
      }
    });

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

    // Sample the count independently of events, too.
    const samples: string[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      samples.push(`${Date.now() - started}ms=${vscode.languages.getDiagnostics(uri).length}`);
      if (vscode.languages.getDiagnostics(uri).length > 0 && i > 4) break;
    }
    sub.dispose();

    console.log('\n===== O :: PUBLISH SEQUENCE =====');
    console.log(`events (${events.length}):`);
    events.forEach((e) => console.log(e));
    console.log(`samples: ${samples.join('  ')}`);
    console.log(`final count: ${vscode.languages.getDiagnostics(uri).length}`);

    // And what does closing the tab we opened cost?
    const tab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => (t.input as vscode.TabInputText | undefined)?.uri?.fsPath === uri.fsPath);
    console.log(`tab found for our uri: ${!!tab}`);
    if (tab) {
      const closed = await vscode.window.tabGroups.close(tab, true);
      console.log(`close() returned: ${closed}`);
      await new Promise((r) => setTimeout(r, 500));
      const still = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some((t) => (t.input as vscode.TabInputText | undefined)?.uri?.fsPath === uri.fsPath);
      console.log(`tab still open after close: ${still}`);
      console.log(`diagnostics after close: ${vscode.languages.getDiagnostics(uri).length}`);
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND 5 — is preserveFocus the reason the tab never appeared?
//
// O showed showTextDocument({preview, preserveFocus}) creating NO tab and
// yielding no diagnostics for 17s, in a window where no editor had ever been
// shown. F saw the same call work in ~500ms — but F ran after other tests had
// already opened editors. If focus preservation is what fails on a cold window,
// then "analyze without disturbing the user" is not achievable this way, and
// that has to be known before shipping it.
// ---------------------------------------------------------------------------

suite('get_diagnostics probe — show variants', () => {
  const files: string[] = [];
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    files.forEach((f) => fs.rmSync(f, { force: true }));
  });

  async function variant(
    name: string,
    opts: vscode.TextDocumentShowOptions,
  ): Promise<{ tab: boolean; count: number; ms: number }> {
    const p = path.join(__dirname, `__var_${name}__.ts`);
    fs.writeFileSync(p, `export const v${name}: number = "not a number";\n`, 'utf-8');
    files.push(p);
    const uri = vscode.Uri.file(p);
    const started = Date.now();

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, opts);
    const res = await waitForDiagnostics(uri, 15_000);
    const tab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some((t) => (t.input as vscode.TabInputText | undefined)?.uri?.fsPath === uri.fsPath);

    console.log(
      `  ${name.padEnd(22)} tab=${String(tab).padEnd(5)} count=${res.count}  ${Date.now() - started}ms  activeEditor=${vscode.window.activeTextEditor?.document.fileName.split('/').pop() ?? 'none'}`,
    );
    return { tab, count: res.count, ms: res.ms };
  }

  test('P: which showTextDocument options actually get a file analyzed?', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('\n===== P :: SHOW VARIANTS (cold window first) =====');
    await variant('previewPreserve', { preview: true, preserveFocus: true });
    await variant('previewFocus', { preview: true, preserveFocus: false });
    await variant('noPreviewFocus', { preview: false, preserveFocus: false });
    await variant('previewPreserve2', { preview: true, preserveFocus: true });
  });
});
