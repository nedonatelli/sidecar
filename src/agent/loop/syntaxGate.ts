// ---------------------------------------------------------------------------
// Syntax gate (deterministic verify).
//
// Dogfooding surfaced the gap: an agent shipped a Python file with a syntax
// error. stub-check only catches placeholders; the completion gate only checks
// that tests/lint RAN; and a newly-created file with no test + no language
// server (e.g. Python without Pylance) gets no verification at all — broken
// code lands on disk silently. This gate closes that hole the deterministic
// way the ablation told us to prefer: after edits, run the language's cheap
// parse check and refuse to finish if the code doesn't parse. No model
// judgment, no false positives — it either parses or it doesn't.
//
// Scope: languages with a fast, dependency-free per-file syntax check. TS is
// intentionally omitted — it's covered by tsc + VS Code diagnostics (autofix),
// and there's no cheap per-file TS syntax check.
// ---------------------------------------------------------------------------

const PARSE_CHECKERS: ReadonlyArray<{ ext: RegExp; cmd: (quoted: string) => string }> = [
  { ext: /\.py$/i, cmd: (q) => `python3 -m py_compile ${q} 2>&1` },
  { ext: /\.(js|cjs|mjs)$/i, cmd: (q) => `node --check ${q} 2>&1` },
];

/** Single-quote a path for the shell (handles spaces and embedded quotes). */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The parse-check command for a file, or null if no cheap per-file checker applies. */
export function parseCheckCommand(relPath: string): string | null {
  const checker = PARSE_CHECKERS.find((c) => c.ext.test(relPath));
  return checker ? checker.cmd(shellQuote(relPath)) : null;
}

/**
 * Distinguish "the checker itself couldn't run" (interpreter not installed,
 * file gone) from a genuine syntax error. We must NOT reprompt in the former
 * case — a missing `python3` is not the agent's bug, and blocking on it would
 * make the gate fire forever.
 */
export function isCheckerUnavailable(exitCode: number, output: string): boolean {
  if (exitCode === 127) return true;
  return /command not found|: not found|No such file or directory|can't open file|cannot find module/i.test(output);
}

export interface SyntaxFailure {
  file: string;
  output: string;
}

/**
 * Run the parse check on each edited file that has one. `runCmd` is injected so
 * this is unit-testable without a real shell. Files whose checker is
 * unavailable are skipped (never reported as failures). Returns the genuine
 * syntax failures.
 */
export async function runSyntaxGate(
  editedFiles: readonly string[],
  runCmd: (cmd: string) => Promise<{ exitCode: number; output: string }>,
): Promise<SyntaxFailure[]> {
  const failures: SyntaxFailure[] = [];
  for (const file of editedFiles) {
    const cmd = parseCheckCommand(file);
    if (!cmd) continue;
    const { exitCode, output } = await runCmd(cmd);
    if (exitCode === 0) continue;
    if (isCheckerUnavailable(exitCode, output)) continue;
    failures.push({ file, output: output.trim().slice(0, 800) });
  }
  return failures;
}

/** Returns true if any edited file has a parse-checker (cheap pre-check to avoid spawning a shell). */
export function hasCheckableFiles(editedFiles: readonly string[]): boolean {
  return editedFiles.some((f) => parseCheckCommand(f) !== null);
}

/** Synthetic reprompt naming the unparseable files and their errors. */
export function buildSyntaxReprompt(failures: SyntaxFailure[]): string {
  const lines: string[] = ['Your edited code does not parse — fix these syntax errors before finishing:', ''];
  for (const f of failures) {
    lines.push(`• \`${f.file}\``);
    lines.push('```');
    lines.push(f.output);
    lines.push('```');
    lines.push('');
  }
  lines.push('Read the file, fix the syntax error, and do not finish with code that fails to parse.');
  return lines.join('\n');
}
