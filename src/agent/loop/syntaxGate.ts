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
// Scope: TWO checkers, in priority order.
//   1. IN-PROCESS (tree-sitter) — TypeScript + 18 other languages, ~0.1ms per
//      parse once warm, no shell. See `agent/tools/syntaxCheck.ts`.
//   2. SHELL (py_compile / node --check) — retained for Python and JS, where
//      the interpreter reports errors tree-sitter's error recovery can smooth
//      over (e.g. IndentationError).
//
// TS was previously omitted on the theory that tsc + VS Code diagnostics cover
// it. Dogfooding disproved that: in a workspace with neither, a TS-only edit
// logged "no parse-checkable files among edited" and the run FINISHED with a
// syntactically broken .ts file on disk. Any language we can parse, we check.
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

/**
 * Positive evidence that the output describes a real syntax error. Both
 * checkers print one of these markers on genuine breakage (py_compile →
 * SyntaxError / IndentationError / TabError; `node --check` → SyntaxError).
 *
 * The gate requires this evidence before reporting a failure — a nonzero exit
 * code alone is NOT enough. A deterministic gate that false-positives is worse
 * than no gate: on a weak model an empty/garbled "syntax error" reprompt makes
 * it "fix" code that already parses, corrupting a working file (observed in
 * dogfooding — a clean, tested calculator.py was edited into a real
 * SyntaxError because the gate fired on a nonzero exit with no error text).
 */
export function hasSyntaxErrorEvidence(output: string): boolean {
  return /\b(SyntaxError|IndentationError|TabError)\b/.test(output);
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
  readFile?: (file: string) => Promise<string | null>,
): Promise<SyntaxFailure[]> {
  const failures: SyntaxFailure[] = [];

  // In-process parse check first — covers TypeScript and 18 other languages
  // with no shell, and is the only coverage TS gets (there is no cheap
  // per-file tsc check, so TS edits used to reach "done" completely
  // unverified: the v0.119 dogfood run finished with a syntactically broken
  // .ts file after logging "no parse-checkable files among edited"). ~0.1ms
  // per parse once the grammar is warm; fails open when no grammar applies.
  if (readFile) {
    const { checkSyntax } = await import('../tools/syntaxCheck.js');
    for (const file of editedFiles) {
      const content = await readFile(file).catch(() => null);
      if (content === null) continue;
      const result = await checkSyntax(file, content);
      if (!result.checked || !result.broken) continue;
      const where = result.firstErrorLine ? ` at line ${result.firstErrorLine}` : '';
      failures.push({
        file,
        output:
          `${file} does not parse${where} (${result.errorCount} syntax error${result.errorCount === 1 ? '' : 's'}). ` +
          `Read the file and fix the broken syntax — check for wrongly escaped characters, unbalanced ` +
          `brackets, or a construct that was only partially replaced.`,
      });
    }
  }

  for (const file of editedFiles) {
    if (failures.some((f) => f.file === file)) continue; // already reported in-process
    const cmd = parseCheckCommand(file);
    if (!cmd) continue;
    const { exitCode, output } = await runCmd(cmd);
    // The fire decision rests SOLELY on positive syntax-error evidence in the
    // output — never on the exit code. The shell session's exit code is
    // unreliable in both directions: it has reported nonzero on a command that
    // succeeded (→ false positive on valid code) AND its sentinel parser
    // defaults to 0 when it can't parse the marker (→ would skip genuinely
    // broken code if we gated on `exitCode === 0`, a false negative). The
    // SyntaxError/IndentationError/TabError marker is present iff the code
    // truly fails to parse, so evidence alone is both necessary and sufficient.
    if (isCheckerUnavailable(exitCode, output)) continue;
    if (!hasSyntaxErrorEvidence(output)) continue;
    failures.push({ file, output: output.trim().slice(0, 800) });
  }
  return failures;
}

/** Extensions the in-process (tree-sitter) parse check covers. Mirrors syntaxCheck.ts. */
const IN_PROCESS_CHECKABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cpp|cs|php|lua|swift|kt|scala|dart)$/i;

/**
 * Returns true if any edited file can be parse-checked at all — in-process
 * (tree-sitter, covers TS + 18 more) or via a shell checker. Previously this
 * only saw the two shell checkers, so a TS-only edit logged "no parse-checkable
 * files" and finished unverified — which is how a syntactically broken .ts file
 * reached "done" in the v0.119 dogfood run.
 */
export function hasCheckableFiles(editedFiles: readonly string[]): boolean {
  return editedFiles.some((f) => IN_PROCESS_CHECKABLE.test(f) || parseCheckCommand(f) !== null);
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
