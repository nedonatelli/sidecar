// Python indentation validation — the gap tree-sitter leaves.
//
// Verified against the shipped grammar: tree-sitter-python parses BOTH of these
// as clean, though CPython rejects both:
//
//   def welcome(name): return name        # orphaned body → IndentationError
//       return name
//
//   def f():                              # mis-indented → IndentationError
//       x = 1
//     y = 2
//
// This matters more than completeness. The corruption class that cost a whole
// dogfood session — replacing a block HEADER with a self-contained one-liner,
// orphaning the body — surfaces in Python as exactly an indentation error. So
// the very failure the syntax guard exists to prevent would sail through on .py
// files. The completion-time gate's py_compile eventually catches it, but only
// after the broken file is on disk and only if a weak model can then repair it.
// Prevention beats detection.
//
// A FALSE POSITIVE here refuses a legitimate edit, which is worse than the
// corruption it prevents — so this is validated against the real Python standard
// library (see pythonIndentCorpus.test.ts), not just hand-written fixtures. Two
// false positives found that way drove the design:
//   • a docstring opening `"""The name …, e.g.:` — a colon INSIDE a string, read
//     as a block opener (ipaddress.py);
//   • a line closing a triple-quote and then opening a `{` — the bracket
//     continuation lost because the rest of the line was skipped (textwrap.py).
// Both vanish once strings and comments are MASKED and brackets are tracked
// across physical lines, which is what the scanner below does.

export interface IndentError {
  /** 1-based line number. */
  line: number;
  message: string;
}

/** One logical line: its indent, its 1-based start line, and its code with strings/comments MASKED. */
interface LogicalLine {
  /** Indent column with tabs to the next multiple of 8: CPython's structural measure. */
  indent: number;
  /** Indent column with a tab counted as 1: CPython's consistency check (`altcol`). */
  altIndent: number;
  line: number;
  code: string;
  /** True when this logical line was joined from a backslash continuation. */
  viaBackslash: boolean;
}

/** Result of the scan. `confident` is false when the source could not be read reliably. */
interface ScanResult {
  lines: LogicalLine[];
  confident: boolean;
}

const TRIPLE_DOUBLE = '"'.repeat(3);
const TRIPLE_SINGLE = "'".repeat(3);

/**
 * Split source into logical lines, masking string contents and comments, and
 * joining physical lines that continue inside brackets or after a backslash.
 * The masked code is what the indent rules see, so a `:` or `{` inside a string
 * can never be mistaken for syntax.
 */
function logicalLines(source: string): ScanResult {
  const out: LogicalLine[] = [];
  let confident = true;
  const n = source.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const lineStart = i;
    // Two columns, as CPython's tokenizer measures them: `indent` with tabs to
    // the next multiple of 8, `altIndent` with a tab as one column. For an
    // all-space or all-tab file they order lines identically; they disagree only
    // where tab width decides the structure, which is CPython's TabError.
    let indent = 0;
    while (i < n && (source[i] === ' ' || source[i] === '\t')) {
      indent = source[i] === '\t' ? (Math.floor(indent / 8) + 1) * 8 : indent + 1;
      i++;
    }
    const altIndent = i - lineStart;
    const startLine = line;

    let code = '';
    let depth = 0;
    let done = false;
    let viaBackslash = false;

    while (i < n && !done) {
      const ch = source[i];

      if (ch === '\n') {
        line++;
        i++;
        if (depth > 0) {
          code += ' '; // continuation inside brackets
          continue;
        }
        if (/\\\s*$/.test(code)) {
          code = code.replace(/\\\s*$/, ' '); // backslash continuation
          viaBackslash = true;
          continue;
        }
        done = true;
        break;
      }

      if (ch === '#') {
        while (i < n && source[i] !== '\n') i++; // comment → EOL
        continue;
      }

      if (ch === '"' || ch === "'") {
        const isTriple = source.startsWith(TRIPLE_DOUBLE, i) || source.startsWith(TRIPLE_SINGLE, i);
        const delim = isTriple ? source.slice(i, i + 3) : ch;
        i += delim.length;
        // Mask to a PLACEHOLDER, not to whitespace. A string is not syntax, but
        // a string-expression statement IS a logical line — a docstring is the
        // body of the block above it. Masking it to blank dropped the line
        // entirely, so the next statement looked like a missing indented block:
        //     class BdbQuit(Exception):
        //         """Exception to give up completely."""   ← the body
        //     class Bdb:                                    ← falsely flagged
        code += 'S';
        while (i < n) {
          if (source[i] === '\\') {
            if (source[i + 1] === '\n') line++;
            i += 2;
            continue;
          }
          if (source[i] === '\n') {
            if (!isTriple) {
              // A quote that never closed on its line. Either a stray quote or a
              // construct we do not model — notably a PEP 701 multi-line
              // f-string (`f"foo {` … `} bar"`, legal since 3.12). We have lost
              // the thread; do not guess at indentation from here.
              confident = false;
              break;
            }
            line++;
            i++;
            continue;
          }
          if (source.startsWith(delim, i)) {
            i += delim.length;
            break;
          }
          i++;
        }
        continue;
      }

      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);

      code += ch;
      i++;
    }

    if (code.trim() !== '') out.push({ indent, altIndent, line: startLine, code: code.trimEnd(), viaBackslash });
    if (!done && i >= n) break;
  }

  return { lines: out, confident };
}

const opensBlock = (code: string): boolean => /:\s*$/.test(code);

/** At most this many errors are reported; `saturated` says whether there were more. */
export const PYTHON_INDENT_ERROR_CAP = 10;

/**
 * Validate Python indentation. Returns [] when the source is fine OR when it
 * cannot be read with confidence — never a guess.
 */
export function findPythonIndentErrors(source: string): IndentError[] {
  return scanPythonIndent(source).errors;
}

/**
 * The errors, capped at PYTHON_INDENT_ERROR_CAP, and whether the cap cut the
 * list short. The count used to stop at 10 silently, so a file with 50 errors
 * reported "10" as if that were all of them (ML-50, #157).
 */
export function scanPythonIndent(source: string): { errors: IndentError[]; saturated: boolean } {
  const all = collectIndentErrors(source, PYTHON_INDENT_ERROR_CAP + 1);
  return { errors: all.slice(0, PYTHON_INDENT_ERROR_CAP), saturated: all.length > PYTHON_INDENT_ERROR_CAP };
}

function collectIndentErrors(source: string, cap: number): IndentError[] {
  // Tabs and spaces mixed for indentation used to switch the whole check off,
  // so an edit that introduced one tab line in a space-indented file was never
  // checked at all -- and inconsistent tabs are exactly what CPython rejects
  // (ML-51, #157). Mixed files are now measured the way CPython measures them
  // (see `indent` / `altIndent` above) and checked like any other, plus
  // CPython's own TabError rule, `inconsistentTabs` below.

  // Form feeds are legal whitespace in Python and can appear INSIDE a line.
  // Vanishingly rare in real code, and modelling them is not worth a false
  // refusal — skip the file.
  if (source.includes('\f')) return [];

  // A physical line that is nothing but a backslash (black's
  // backslash_before_indent case) makes the joined logical line's indent
  // unreadable — the indent is measured on a line with no code at all. Rare
  // enough that skipping the file beats modelling it.
  if (/^[ \t]*\\[ \t]*$/m.test(source)) return [];

  const { lines, confident } = logicalLines(source);
  if (!confident) return [];
  const errors: IndentError[] = [];
  const stack: number[] = [0];

  errors.push(...inconsistentTabs(lines).slice(0, cap));

  for (let k = 1; k < lines.length && errors.length < cap; k++) {
    const prev = lines[k - 1];
    const cur = lines[k];
    const prevOpens = opensBlock(prev.code);

    // A block opener (`:` ending a logical line) REQUIRES its body indented
    // deeper than the opener. If the next logical line is at the SAME indent or
    // SHALLOWER, the body was orphaned — CPython raises "expected an indented
    // block", but tree-sitter parses it clean. This is the corruption class the
    // guard exists for (an edit deletes a block's only statement, e.g. removing
    // the `break` under an `else:`, leaving `else:` immediately followed by a
    // dedented line). The shallower case used to fall through to the dedent
    // branch, match a valid outer level, and ship a file that will not compile.
    if (prevOpens) {
      if (cur.indent > prev.indent) {
        stack.push(cur.indent);
      } else {
        errors.push({
          line: cur.line,
          message: `expected an indented block after the ':' on line ${prev.line}`,
        });
        // Resync to cur's level so a single orphan does not cascade into
        // spurious unindent errors across the rest of the file.
        while (stack.length > 1 && stack[stack.length - 1] > cur.indent) stack.pop();
        if (stack[stack.length - 1] !== cur.indent) stack.push(cur.indent);
      }
      continue;
    }

    if (cur.indent > prev.indent) {
      errors.push({
        line: cur.line,
        message: `unexpected indent — line ${cur.line} is indented deeper than the line above it, which does not open a block (no trailing ':')`,
      });
    } else if (cur.indent < prev.indent) {
      while (stack.length > 1 && stack[stack.length - 1] > cur.indent) stack.pop();
      if (stack[stack.length - 1] !== cur.indent) {
        errors.push({
          line: cur.line,
          message: `unindent does not match any outer indentation level (line ${cur.line})`,
        });
        stack.push(cur.indent); // resync so one error does not cascade
      }
    }
  }

  if (errors.length < cap) errors.push(...orphanedClauses(lines).slice(0, cap - errors.length));
  return errors.sort((a, b) => a.line - b.line).slice(0, cap);
}

/**
 * CPython's TabError (`inconsistent use of tabs and spaces in indentation`),
 * ported from the tokenizer's indent check: each logical line's indent is
 * measured with tabs as 8 columns (`indent`) and as 1 (`altIndent`), and the
 * two must tell the same story against the indent stack -- equal where one is
 * equal, deeper where one is deeper. Where they disagree, the block structure
 * depends on tab width, and CPython refuses the file. Space-only and tab-only
 * files can never disagree, so this only ever fires on mixed indentation.
 */
function inconsistentTabs(lines: LogicalLine[]): IndentError[] {
  const errors: IndentError[] = [];
  const stack: Array<{ col: number; alt: number }> = [{ col: 0, alt: 0 }];
  const tabError = (line: number): IndentError => ({
    line,
    message: `inconsistent use of tabs and spaces in indentation (line ${line})`,
  });
  for (const cur of lines) {
    const top = stack[stack.length - 1];
    if (cur.indent === top.col) {
      if (cur.altIndent !== top.alt) errors.push(tabError(cur.line));
    } else if (cur.indent > top.col) {
      if (cur.altIndent <= top.alt) errors.push(tabError(cur.line));
      stack.push({ col: cur.indent, alt: cur.altIndent });
    } else {
      while (stack.length > 1 && cur.indent < stack[stack.length - 1].col) stack.pop();
      const back = stack[stack.length - 1];
      // An unindent matching no outer level is the structural check's error, not this one.
      if (cur.indent === back.col && cur.altIndent !== back.alt) errors.push(tabError(cur.line));
    }
  }
  return errors;
}

/** The headers each continuation clause may follow, at its own indentation. */
const CLAUSE_FOLLOWS: Record<string, readonly string[]> = {
  elif: ['if', 'elif'],
  else: ['if', 'elif', 'for', 'while', 'try', 'except'],
  except: ['try', 'except'],
  finally: ['try', 'except', 'else'],
};

/** The compound-statement keyword a logical line starts with (`async for` -> `for`), or null. */
function headerKeyword(code: string): string | null {
  const m = /^(?:async\s+)?(if|elif|else|for|while|try|except|finally|with|def|class|match|case)\b/.exec(
    code.trimStart(),
  );
  return m && code.includes(':') ? m[1] : null;
}

/**
 * `else` / `elif` / `except` / `finally` that do not continue a statement
 * they can belong to (#157 ML-09). tree-sitter-python reads an out-of-place
 * `else` as an identifier and parses the file clean, and the indentation rules
 * above see nothing wrong with it, so an edit that deleted an `if` header and
 * left its `else:` -- or wrote `return 1` in place of `if x >= 0:\n    return 1`
 * -- was written, and CPython refused the file. The clause must follow, at its
 * own indentation, a header it can continue (a one-line `if x: y = 1` counts);
 * anything else there is the error CPython reports.
 */
function orphanedClauses(lines: LogicalLine[]): IndentError[] {
  const errors: IndentError[] = [];
  for (let k = 0; k < lines.length; k++) {
    const clause = /^(elif|else|except|finally)\b/.exec(lines[k].code.trimStart())?.[1];
    if (!clause) continue;
    // The statement before it at its own level: skip the deeper lines of the
    // previous clause's body.
    let j = k - 1;
    while (j >= 0 && lines[j].indent > lines[k].indent) j--;
    const header = j >= 0 && lines[j].indent === lines[k].indent ? headerKeyword(lines[j].code) : null;
    if (header === null || !CLAUSE_FOLLOWS[clause].includes(header)) {
      errors.push({
        line: lines[k].line,
        message: `'${clause}' on line ${lines[k].line} does not follow a statement it can continue (${CLAUSE_FOLLOWS[clause].map((h) => `'${h}'`).join(', ')}) at the same indentation`,
      });
    }
  }
  return errors;
}
