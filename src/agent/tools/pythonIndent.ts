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
  indent: number;
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
    while (i < n && (source[i] === ' ' || source[i] === '\t')) i++;
    const indent = i - lineStart;
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

    if (code.trim() !== '') out.push({ indent, line: startLine, code: code.trimEnd(), viaBackslash });
    if (!done && i >= n) break;
  }

  return { lines: out, confident };
}

const opensBlock = (code: string): boolean => /:\s*$/.test(code);

/**
 * Validate Python indentation. Returns [] when the source is fine OR when it
 * cannot be read with confidence — never a guess.
 */
export function findPythonIndentErrors(source: string): IndentError[] {
  // Tabs vs spaces: whether a tab-indented line lines up with a space-indented
  // one depends on tab width, which we will not adjudicate. A file that mixes
  // both for indentation is skipped rather than risk a false refusal.
  const indents = source.split('\n').map((l) => /^[ \t]*/.exec(l)?.[0] ?? '');
  const usesTabs = indents.some((s) => s.includes('\t'));
  const usesSpaces = indents.some((s) => s.includes(' '));
  if (usesTabs && usesSpaces) return [];

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

  for (let k = 1; k < lines.length && errors.length < 10; k++) {
    const prev = lines[k - 1];
    const cur = lines[k];
    const prevOpens = opensBlock(prev.code);

    if (cur.indent > prev.indent) {
      if (!prevOpens) {
        errors.push({
          line: cur.line,
          message: `unexpected indent — line ${cur.line} is indented deeper than the line above it, which does not open a block (no trailing ':')`,
        });
      } else {
        stack.push(cur.indent);
      }
    } else if (cur.indent < prev.indent) {
      while (stack.length > 1 && stack[stack.length - 1] > cur.indent) stack.pop();
      if (stack[stack.length - 1] !== cur.indent) {
        errors.push({
          line: cur.line,
          message: `unindent does not match any outer indentation level (line ${cur.line})`,
        });
        stack.push(cur.indent); // resync so one error does not cascade
      }
    } else if (prevOpens) {
      errors.push({
        line: cur.line,
        message: `expected an indented block after the ':' on line ${prev.line}`,
      });
    }
  }

  return errors;
}
