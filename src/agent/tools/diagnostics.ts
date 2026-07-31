import { languages, window, workspace, Uri, type Tab, type TabInputText } from 'vscode';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool, ToolExecutorContext } from './shared.js';
import { scanFile, formatIssues } from '../securityScanner.js';
import { getRoot, getRootUri } from './shared.js';

// Diagnostics tool: merges VS Code's language-server diagnostics with
// SideCar's security scanner. Exported as a function (not just via the
// registry) because the agent loop also calls it directly after edits.
//
// WHY THIS TOOL OPENS A TAB
//
// `languages.getDiagnostics(uri)` does not ask anyone to analyze anything — it
// reads what a language server has already published, and a server publishes
// for files in its OPEN set. A file the agent wrote to disk is not in it, so
// the tool returned nothing for exactly the case it exists to serve: 30 of 33
// real calls in the audit log said "No diagnostics", and all 3 non-empty
// results came from SideCar's own security scanner.
//
// Measured in a real extension host (see src/test/integration/diagnosticsProbe.test.ts):
//
//   not opened                         → 0 after 10s
//   workspace.openTextDocument alone   → 0 after 20s   (opening is NOT enough)
//   showTextDocument, focus stolen     → 1 in ~520ms, reliably
//   showTextDocument, preserveFocus    → works, but latency is unpredictable on
//                                        a COLD window (no editor ever shown):
//                                        5.1s in one run, still 0 at 17s in
//                                        another. Reliable ~520ms once any
//                                        editor exists.
//   content-neutral dirty touch        → 1 in ~2.3s, but leaves the document
//                                        dirty forever: there is no revert
//                                        command for a non-active document, and
//                                        saving would fire format-on-save and
//                                        rewrite the user's file
//   diagnostics after closing the tab  → retained
//
// So the file has to enter the open set, and the only acceptable way to do that
// during agent work is a PREVIEW tab that takes no focus, closed again
// immediately. No dirty buffer, no save, no format-on-save, no focus change.
//
// WHAT THIS STILL CANNOT DO: prove a file is clean. There is no public signal
// for "the server finished and found nothing" — an onDidChangeDiagnostics event
// fired for a genuinely broken file with count=0 at 1.4s, with the real error
// arriving later. An unfinished analysis is indistinguishable from a clean one,
// so a POSITIVE result is trustworthy and an empty one never is. The completion
// gate keys on exactly that asymmetry.
//
// This is what every other agent does too, just less quietly: the ones that get
// reliable diagnostics (Cline's diff editor, Copilot's in-editor edits) have the
// file open by design. There is no API that analyzes a file outside the open set.

export const getDiagnosticsDef: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    "Fetch compiler errors, warnings, and lint issues from VS Code's language services for a file, plus a security scan of it. " +
    'Use after `write_file` / `edit_file` to check your change, and before starting a task to see what is already broken. ' +
    'When you pass `path`, the file is analyzed on demand, so the result reflects what you just wrote. ' +
    'A whole-project call (no `path`) does NOT analyze anything — it only lists what is already known, so it can look clean while an unopened file is broken. ' +
    "For the strongest verification of a change — and for anything beyond one file — run the real checker: `run_command` with `npx tsc --noEmit` / `npx eslint <file>` (or this language's equivalent), or `run_tests`. " +
    'Not for running tests (use `run_tests`). ' +
    'Omit `path` to get a project-wide summary. ' +
    'Example after an edit: `get_diagnostics(path="src/utils.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional: relative file path to get diagnostics for. Omit for all files.' },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

/** A tab currently showing `uri`, if any. */
function tabFor(uri: Uri): Tab | undefined {
  // `tabGroups` is missing on older hosts and in test doubles; a missing window
  // API means "we cannot manage tabs", never a crash inside a read-only tool.
  return (window.tabGroups?.all ?? [])
    .flatMap((g) => g.tabs)
    .find((t) => (t.input as TabInputText | undefined)?.uri?.fsPath === uri.fsPath);
}

/**
 * Resolve once a language server publishes diagnostics for `uri`, or when the
 * budget expires. Waiting on the event rather than a fixed sleep is what keeps
 * this fast in the common case (~434ms measured) without being wrong on a cold
 * TypeScript project, where the first analysis takes seconds.
 */
function awaitDiagnostics(uri: Uri, budgetMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.fsPath === uri.fsPath)) finish();
    });
    const timer = setTimeout(finish, budgetMs);
  });
}

/**
 * Put `uri` into the language server's open set long enough for it to be
 * analyzed, then restore the editor to how we found it.
 *
 * Best-effort throughout: a binary file, a deleted path, or a workspace with no
 * window all just mean "no analysis happened", which is the status quo, never an
 * error the model has to handle.
 */
async function analyzeInEditor(uri: Uri, budgetMs: number): Promise<void> {
  const alreadyOpen = tabFor(uri);
  if (alreadyOpen) {
    // The user (or a previous call) has it open — it is already analyzed, and
    // closing their tab would be rude. Just let any pending change settle.
    await awaitDiagnostics(uri, Math.min(budgetMs, 1_000));
    return;
  }
  if (typeof window.showTextDocument !== 'function' || !window.tabGroups) return;
  try {
    const doc = await workspace.openTextDocument(uri);
    const settled = awaitDiagnostics(uri, budgetMs);
    await window.showTextDocument(doc, { preview: true, preserveFocus: true });
    await settled;
  } catch {
    /* unopenable path — nothing was analyzed, same as before */
  } finally {
    // Close exactly the tab we opened — never closeAllEditors, which would take
    // the user's own tabs with it.
    //
    // Polled, because the tab model updates asynchronously: showTextDocument
    // can resolve before the tab is registered, and a single immediate lookup
    // then finds nothing and leaves the tab behind for the user to discover.
    if (!alreadyOpen) {
      for (let i = 0; i < 20; i++) {
        const ours = tabFor(uri);
        if (ours) {
          try {
            await window.tabGroups.close(ours, true);
          } catch {
            /* already gone */
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}

export async function getDiagnostics(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string | undefined;
  const root = getRoot();

  if (filePath) {
    const fileUri = Uri.joinPath(getRootUri(), filePath);
    // Ask for the file to be analyzed before reading the cache. Disabled by
    // config for anyone who would rather have a useless tool than a tab that
    // blinks, and skipped when the agent is pinned to a shadow workspace (that
    // path is not the file the editor would open).
    const budget = context?.config?.diagnosticsAnalysisBudgetMs ?? 5_000;
    if (budget > 0 && !context?.cwd) await analyzeInEditor(fileUri, budget);
    const diags = languages.getDiagnostics(fileUri);
    const results = diags.map((d) => {
      const line = d.range.start.line + 1;
      const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
      return `${filePath}:${line} [${severity}] ${d.message}`;
    });

    // Append security scan results
    const securityIssues = await scanFile(filePath);
    const securityOutput = formatIssues(securityIssues);
    if (securityOutput) results.push(securityOutput);

    if (results.length > 0) return results.join('\n');
    // An empty result is NEVER promoted to "clean", however hard we tried.
    //
    // Opening the file makes real errors surface, which is the whole point of
    // the dance above — but there is no public signal for "the server finished
    // and found nothing". Measured: an onDidChangeDiagnostics event fired for a
    // genuinely broken file with count=0 at 1.4s, and the real error only
    // appeared later (sometimes 5s, sometimes not within 17s on a cold window).
    // So an empty set is indistinguishable from an unfinished one, and claiming
    // otherwise would rebuild the exact false-confidence this tool started with.
    return (
      `No diagnostics reported for ${filePath}. This is NOT proof the file is clean — an analysis that has not ` +
      `finished looks exactly like one that found nothing. To verify, run the project's type-checker or linter ` +
      `(e.g. run_command with \`npx tsc --noEmit\`) or run_tests.`
    );
  }

  // All diagnostics
  const allDiags = languages.getDiagnostics();
  const results: string[] = [];
  for (const [uri, diags] of allDiags) {
    if (diags.length === 0) continue;
    const relPath = root ? path.relative(root, uri.fsPath) : uri.fsPath;
    if (relPath.includes('node_modules')) continue;
    for (const d of diags) {
      const line = d.range.start.line + 1;
      const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
      results.push(`${relPath}:${line} [${severity}] ${d.message}`);
    }
  }
  // A project-wide call analyzes nothing — it reports what is already known.
  // An empty result here says only "nothing has been reported", which for files
  // nobody has opened is uninformative rather than reassuring.
  return results.length > 0
    ? results.slice(0, 100).join('\n')
    : 'No diagnostics found. NOTE: this lists only what language services have already reported; files nobody has opened are not analyzed, so this is not proof the project is clean.';
}

// Module-level RegisteredTool[] array. Composed into
// TOOL_REGISTRY via spread in tools.ts. Keeps the paired def/executor
// exports above for backward compat with any direct importers.
export const diagnosticsTools: RegisteredTool[] = [
  { definition: getDiagnosticsDef, executor: getDiagnostics, requiresApproval: false },
];
