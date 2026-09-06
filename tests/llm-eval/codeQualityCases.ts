import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Code-quality eval cases: creation completeness and fixing correctness.
//
// Two clusters:
//
//   A. Anti-stub / completeness — every case asserts the written file
//      contains NO stub markers (TODO, FIXME, placeholder, not-implemented
//      throws, etc.).  These are the cases that exercise:
//
//        1. `stubValidator.ts` detection patterns
//        2. `stubCheck.ts` reprompt injection (MAX_STUB_RETRIES = 1)
//        3. The agent responding correctly to the reprompt
//
//      Each case isolates a different stub scenario so a regression in
//      any single pattern is caught without cascading into adjacent cases.
//
//   B. Code-fix correctness — cases where the agent must identify a
//      specific bug class, apply a minimal targeted fix, and leave
//      surrounding code untouched. Each tests a different failure mode:
//      type annotation, off-by-one, missing await, multi-bug, wrong
//      operator, and truncated body.
//
// Authoring notes:
//   - Workspaces stay under 30 lines of total content.
//   - Every notContain check mirrors at least one `STUB_PATTERNS` entry
//     from stubValidator.ts so there's a direct line from pattern to case.
//   - Fix cases use deliberately obscure values (e.g. specific version
//     strings, oddly-named vars) so the model cannot guess the right
//     answer from training weights; it must actually read the file.
// ---------------------------------------------------------------------------

export const CODE_QUALITY_CASES: AgentEvalCase[] = [
  // ---------------------------------------------------------------------------
  // A. Anti-stub: creation completeness
  // ---------------------------------------------------------------------------

  {
    id: 'no-stub-multi-function-module',
    description: 'Agent writes a three-function utility module; every function must have a real body',
    tags: ['write', 'stub-validator', 'regression'],
    workspace: {
      'README.md': '# Eval sandbox\n',
    },
    userMessage:
      'Create src/strUtils.ts with three exported TypeScript functions:\n' +
      '1. `truncate(s: string, max: number): string` — returns `s` unchanged when it fits in `max` chars, ' +
      'otherwise returns the first `max - 3` characters followed by "...".\n' +
      '2. `capitalize(s: string): string` — returns `s` with only the first character uppercased.\n' +
      '3. `countWords(s: string): number` — returns the number of whitespace-delimited words in `s` ' +
      '(empty string = 0 words).\n' +
      'All three functions must be fully implemented — no TODO comments, no placeholder returns.',
    expect: {
      // Either tracked write tool. `edit_file` on a path that does not exist is
      // coerced into a create (a shim for llama3.2's call shape), so a model can
      // reach the same tracked, undoable result by that route. An untracked
      // shell heredoc still fails, which is what this assertion is for.
      toolsCalledAny: ['write_file', 'edit_file'],
      files: {
        exist: ['src/strUtils.ts'],
        contain: [
          {
            path: 'src/strUtils.ts',
            substrings: ['truncate', 'capitalize', 'countWords', 'export', 'return'],
          },
        ],
        // Mirror stubValidator.STUB_PATTERNS categories:
        notContain: [
          {
            path: 'src/strUtils.ts',
            substrings: [
              'TODO',
              'FIXME',
              'placeholder',
              'your code here',
              'goes here',
              'not implemented',
              'NotImplementedError',
              'implement',
              '// for now',
              // Note: '...' is intentionally absent here — truncate() must
              // return s.slice(0, max - 3) + '...', so the ellipsis string
              // is part of a correct implementation, not a stub marker.
            ],
          },
        ],
      },
    },
  },

  {
    id: 'no-stub-class-with-methods',
    description:
      'Agent creates a class with constructor + three methods; no method may throw not-implemented or have a TODO body',
    tags: ['write', 'stub-validator', 'regression'],
    workspace: {
      'README.md': '# Eval sandbox\n',
    },
    userMessage:
      'Create src/Counter.ts with an exported TypeScript class `Counter`:\n' +
      '- Constructor takes an optional `initial: number` (default 0) and stores the count.\n' +
      '- `increment(): void` — adds 1 to the count.\n' +
      '- `decrement(): void` — subtracts 1 from the count.\n' +
      '- `value(): number` — returns the current count.\n' +
      'Write the full implementation. No TODO comments, no placeholder bodies, no not-implemented errors.',
    expect: {
      // Either tracked write tool. `edit_file` on a path that does not exist is
      // coerced into a create (a shim for llama3.2's call shape), so a model can
      // reach the same tracked, undoable result by that route. An untracked
      // shell heredoc still fails, which is what this assertion is for.
      toolsCalledAny: ['write_file', 'edit_file'],
      files: {
        exist: ['src/Counter.ts'],
        contain: [
          {
            path: 'src/Counter.ts',
            substrings: ['class Counter', 'constructor', 'increment', 'decrement', 'value', 'export', 'return'],
          },
        ],
        notContain: [
          {
            path: 'src/Counter.ts',
            substrings: [
              'TODO',
              'FIXME',
              'not implemented',
              // 'throw new Error' is intentionally excluded — a constructor
              // validating arguments (e.g. throw new Error('initial must be ≥ 0'))
              // is legitimate code, not a stub. The 'not implemented' substring
              // above catches the actual stub pattern.
              'placeholder',
              'your code here',
            ],
          },
        ],
      },
    },
  },

  {
    id: 'no-stub-implement-interface',
    description:
      'Agent implements a TypeScript interface as a class; every method must have a real body not just a stub throw',
    tags: ['write', 'stub-validator', 'regression'],
    workspace: {
      'src/types.ts':
        'export interface Stack<T> {\n' +
        '  push(item: T): void;\n' +
        '  pop(): T | undefined;\n' +
        '  peek(): T | undefined;\n' +
        '  size(): number;\n' +
        '}\n',
    },
    userMessage:
      'Implement the `Stack<T>` interface from src/types.ts as an exported class `ArrayStack<T>` in src/ArrayStack.ts. ' +
      'Use an internal array to store elements. All four methods must be fully implemented — ' +
      'do not use throw statements as placeholders.',
    expect: {
      // Either tracked write tool. `edit_file` on a path that does not exist is
      // coerced into a create (a shim for llama3.2's call shape), so a model can
      // reach the same tracked, undoable result by that route. An untracked
      // shell heredoc still fails, which is what this assertion is for.
      toolsCalledAny: ['write_file', 'edit_file'],
      files: {
        exist: ['src/ArrayStack.ts'],
        contain: [
          {
            path: 'src/ArrayStack.ts',
            substrings: ['push', 'pop', 'peek', 'size', 'export', 'class ArrayStack', 'return'],
          },
        ],
        notContain: [
          {
            path: 'src/ArrayStack.ts',
            substrings: [
              'TODO',
              'FIXME',
              'not implemented',
              'NotImplementedError',
              'placeholder',
              // 'throw new Error' excluded: pop() on an empty stack legitimately
              // throws. The 'not implemented' substring catches the stub pattern.
            ],
          },
        ],
      },
    },
  },

  {
    id: 'replace-todo-body-with-implementation',
    description: 'Agent edits a file with a TODO-body function and replaces it with a real implementation',
    tags: ['edit', 'stub-validator', 'regression'],
    workspace: {
      // The function has an explicit TODO body — the core stub case
      // the stub validator reprompt is designed to catch. This tests
      // the edit path (agent reads → edit → stub validator fires if
      // the edit still has the TODO → reprompt → clean re-edit).
      'src/clamp.ts':
        '/**\n' +
        ' * Clamps n to [min, max].\n' +
        ' */\n' +
        'export function clamp(n: number, min: number, max: number): number {\n' +
        '  // TODO: implement\n' +
        '  return 0;\n' +
        '}\n',
    },
    userMessage:
      'The `clamp` function in src/clamp.ts has a TODO placeholder body. ' +
      'Replace it with a correct implementation: return `n` clamped to the range [min, max]. ' +
      'Remove the TODO comment — the final file must contain only the working function.',
    expect: {
      files: {
        contain: [
          {
            path: 'src/clamp.ts',
            substrings: ['function clamp', 'return', 'min', 'max'],
          },
        ],
        notContain: [
          {
            path: 'src/clamp.ts',
            substrings: [
              'TODO',
              'FIXME',
              '// implement',
              'placeholder',
              '  return 0;', // the original stub return must be gone
            ],
          },
        ],
      },
    },
  },

  {
    id: 'no-stub-add-function-to-existing-file',
    description: 'Agent adds a new function to an existing module; the new function must be fully implemented',
    tags: ['edit', 'stub-validator', 'regression'],
    workspace: {
      'src/math.ts': 'export function add(a: number, b: number): number {\n' + '  return a + b;\n' + '}\n',
    },
    userMessage:
      'Add a `multiply(a: number, b: number): number` function to src/math.ts that returns the product of a and b. ' +
      'Export it. The existing `add` function must remain unchanged. ' +
      'Write the complete multiply implementation — no TODO comments or placeholder returns.',
    expect: {
      files: {
        contain: [
          {
            path: 'src/math.ts',
            substrings: ['function add', 'return a + b', 'multiply', 'export', 'return'],
          },
        ],
        notContain: [
          {
            path: 'src/math.ts',
            substrings: ['TODO', 'FIXME', 'placeholder', 'not implemented'],
          },
        ],
      },
    },
  },

  {
    id: 'no-stub-error-handling',
    description: 'Agent adds error handling to a function using real try/catch, not a TODO comment',
    tags: ['edit', 'stub-validator', 'regression'],
    workspace: {
      'src/parser.ts': 'export function parseJson(raw: string): unknown {\n' + '  return JSON.parse(raw);\n' + '}\n',
    },
    userMessage:
      'Add error handling to the `parseJson` function in src/parser.ts. ' +
      'If `JSON.parse` throws, the function should return `null` instead of propagating the error. ' +
      'Use a real try/catch block — do not add TODO comments saying "handle errors later".',
    expect: {
      files: {
        contain: [
          {
            path: 'src/parser.ts',
            substrings: ['try', 'catch', 'return null', 'JSON.parse'],
          },
        ],
        notContain: [
          {
            path: 'src/parser.ts',
            substrings: ['TODO', 'FIXME', 'for now', 'placeholder', 'handle error'],
          },
        ],
      },
    },
  },

  // ---------------------------------------------------------------------------
  // B. Code-fix correctness
  // ---------------------------------------------------------------------------

  {
    id: 'fix-wrong-type-annotation',
    description: 'Agent fixes an incorrect return type annotation without changing the function body',
    tags: ['edit', 'bugfix', 'regression'],
    workspace: {
      // The annotation says string but the function returns a number.
      // The value 42 is specific enough that the agent can't guess;
      // it must read to see the mismatch.
      'src/answer.ts':
        '// Returns the answer to everything.\n' + 'export function getAnswer(): string {\n' + '  return 42;\n' + '}\n',
    },
    userMessage:
      'The return type annotation on `getAnswer` in src/answer.ts is wrong — it says `string` but the function returns a number. ' +
      'Fix only the return type annotation to `number`. Do not change the function body.',
    expect: {
      files: {
        contain: [
          {
            path: 'src/answer.ts',
            substrings: ['getAnswer(): number', 'return 42'],
          },
        ],
        notContain: [
          {
            path: 'src/answer.ts',
            substrings: ['getAnswer(): string'],
          },
        ],
      },
    },
  },

  {
    id: 'fix-off-by-one-loop',
    description: 'Agent fixes an off-by-one in a loop boundary without rewriting the surrounding function',
    tags: ['edit', 'bugfix', 'regression'],
    workspace: {
      // sumArray uses `< arr.length - 1` instead of `< arr.length`,
      // skipping the last element. The function name and comment are
      // deliberately unambiguous so the model understands the intent.
      'src/sum.ts':
        '// Returns the sum of all elements in an array of numbers.\n' +
        'export function sumArray(arr: number[]): number {\n' +
        '  let total = 0;\n' +
        '  for (let i = 0; i < arr.length - 1; i++) {\n' +
        '    total += arr[i];\n' +
        '  }\n' +
        '  return total;\n' +
        '}\n',
    },
    userMessage:
      'There is an off-by-one bug in src/sum.ts — the loop in `sumArray` stops one element too early, ' +
      'missing the last element of the array. Fix the loop boundary so all elements are included.',
    expect: {
      files: {
        contain: [
          {
            path: 'src/sum.ts',
            substrings: ['i < arr.length', 'total += arr[i]', 'return total'],
          },
        ],
        notContain: [
          {
            path: 'src/sum.ts',
            substrings: ['arr.length - 1'],
          },
        ],
      },
    },
  },

  {
    id: 'fix-missing-await',
    description: 'Agent adds missing await to an async call that discards its result',
    tags: ['edit', 'bugfix', 'regression'],
    workspace: {
      // writeData calls an async helper but discards the promise.
      // The missing await is the bug; the fix is minimal: add `await`.
      'src/storage.ts':
        'async function persist(data: string): Promise<void> {\n' +
        '  await new Promise<void>((resolve) => setTimeout(resolve, 0));\n' +
        '  void data;\n' +
        '}\n' +
        '\n' +
        'export async function writeData(data: string): Promise<void> {\n' +
        '  persist(data);\n' +
        '}\n',
    },
    userMessage:
      'In src/storage.ts the `writeData` function calls `persist(data)` without awaiting it, ' +
      'so errors are silently dropped. Add `await` to the `persist(data)` call.',
    expect: {
      files: {
        contain: [
          {
            path: 'src/storage.ts',
            substrings: ['await persist(data)'],
          },
        ],
        notContain: [
          {
            // The bare (non-awaited) call must be gone.
            path: 'src/storage.ts',
            substrings: ['  persist(data);'],
          },
        ],
      },
    },
  },

  {
    id: 'fix-two-independent-bugs',
    description:
      'Agent fixes two independent bugs in the same file; both must be corrected and unrelated code must be untouched',
    tags: ['edit', 'bugfix', 'regression'],
    workspace: {
      // Two bugs: (1) divide returns a - b instead of a / b,
      // (2) isEven returns n % 2 !== 0 (inverted). A third function
      // `square` is correct and must remain untouched.
      'src/ops.ts':
        '// Divides a by b.\n' +
        'export function divide(a: number, b: number): number {\n' +
        '  return a - b;\n' +
        '}\n' +
        '\n' +
        '// Returns true when n is even.\n' +
        'export function isEven(n: number): boolean {\n' +
        '  return n % 2 !== 0;\n' +
        '}\n' +
        '\n' +
        '// Returns the square of n.\n' +
        'export function square(n: number): number {\n' +
        '  return n * n;\n' +
        '}\n',
    },
    userMessage:
      'src/ops.ts has two bugs:\n' +
      '1. `divide` returns `a - b` instead of `a / b`.\n' +
      '2. `isEven` returns the wrong boolean — it uses `!== 0` instead of `=== 0`.\n' +
      'Fix both bugs. Leave `square` exactly as it is.',
    expect: {
      files: {
        contain: [
          {
            path: 'src/ops.ts',
            substrings: ['return a / b', 'function square', 'return n * n'],
          },
        ],
        // The even check as a regex, not a substring — `(n % 2) === 0` is the
        // same fix with parentheses, and the literal `n % 2 === 0` rejected it
        // (gemma4:e4b, seed 42, 2026-08-06: both bugs correctly fixed, case
        // scored as failed).
        matchesRegex: [{ path: 'src/ops.ts', patterns: [/\(?\s*n\s*%\s*2\s*\)?\s*===\s*0/] }],
        notContain: [
          {
            path: 'src/ops.ts',
            substrings: ['return a - b', 'n % 2 !== 0', '(n % 2) !== 0'],
          },
        ],
      },
    },
  },

  {
    id: 'fix-wrong-comparison-operator',
    description: 'Agent fixes a max function that uses < instead of > and leaves min untouched',
    tags: ['edit', 'bugfix', 'regression'],
    workspace: {
      // `max` uses < (same bug as returning a minimum).
      // `min` uses <= so the two bodies are distinct — edit_file's first-match
      // replacement can't accidentally corrupt min when the model searches for
      // `a < b ? a : b` (which only appears in max).
      'src/minmax.ts':
        '// Returns the smaller of two numbers.\n' +
        'export function min(a: number, b: number): number {\n' +
        '  return a <= b ? a : b;\n' +
        '}\n' +
        '\n' +
        '// Returns the larger of two numbers.\n' +
        'export function max(a: number, b: number): number {\n' +
        '  return a < b ? a : b;\n' +
        '}\n',
    },
    userMessage:
      'The `max` function in src/minmax.ts is wrong — it uses `a < b ? a : b` which returns the minimum, not the maximum. ' +
      'Fix `max` so it returns the larger value. Leave `min` exactly as it is.',
    expect: {
      files: {
        exist: ['src/minmax.ts'],
        contain: [
          {
            path: 'src/minmax.ts',
            substrings: [
              // min is unchanged — still uses <=
              'function min',
              'a <= b ? a : b',
              'function max',
            ],
          },
        ],
        // Accept any correct implementation: a > b ? a : b, a >= b ? a : b,
        // a < b ? b : a, a <= b ? b : a, Math.max, etc. (>= / <= are correct
        // for max — on ties either operand is the maximum.)
        matchesRegex: [
          { path: 'src/minmax.ts', patterns: [/function max[\s\S]*?(a\s*>=?\s*b|a\s*<=?\s*b\s*\?\s*b|Math\.max)/] },
        ],
        notContain: [
          {
            path: 'src/minmax.ts',
            // the original buggy max body (returns minimum) must be gone
            substrings: ['TODO', 'FIXME', 'not implemented', 'a < b ? a : b'],
          },
        ],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Cross-file cluster — the existing cases are all single-file. A rename that
  // must propagate to a caller in ANOTHER file is where the edit-side scaffolds
  // earn their keep: without them a weak model renames the definition and
  // leaves the caller broken (autofix catches the resulting diagnostic in the
  // real extension; grep-first behavior finds the caller). Cleanly binary, with
  // real headroom — good for `eval:ablation` on the autoFix dimension.
  // -------------------------------------------------------------------------
  {
    id: 'rename-propagates-to-cross-file-caller',
    description: 'Renaming an exported function updates its caller in another file (autofix / cross-file)',
    tags: ['edit', 'cross-file', 'autofix', 'edit-scaffold'],
    workspace: {
      'src/mathUtils.ts':
        '// Adds two numbers.\nexport function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n',
      'src/calc.ts':
        "import { addNumbers } from './mathUtils.js';\n\n" +
        '// Applies a delta to a running total.\n' +
        'export function applyDelta(total: number, delta: number): number {\n  return addNumbers(total, delta);\n}\n',
    },
    userMessage:
      'Rename the `addNumbers` function to `sum` in src/mathUtils.ts. Update every reference across the project so ' +
      'nothing is left calling the old name.',
    expect: {
      // Locating the caller (grep/search) or reading it is the grounded path.
      toolsCalledAny: ['read_file', 'grep', 'search_files'],
      files: {
        contain: [
          { path: 'src/mathUtils.ts', substrings: ['function sum('] },
          // The caller's import AND call site must both move to the new name.
          { path: 'src/calc.ts', substrings: ['sum('] },
        ],
        notContain: [
          { path: 'src/mathUtils.ts', substrings: ['addNumbers'] },
          { path: 'src/calc.ts', substrings: ['addNumbers'] },
        ],
      },
    },
  },

  // -------------------------------------------------------------------------
  // From-scratch construction cluster — the other cases start from a fixture
  // and make a localized change. This one builds a small program toward a goal
  // from an (effectively) empty workspace, exercising the full build loop and
  // the deterministic keepers end-to-end: stub-check on a complete
  // implementation, and the completion gate forcing the agent to actually run
  // the tests it writes rather than declaring success.
  // -------------------------------------------------------------------------
  {
    id: 'build-python-calculator',
    description: 'Builds a Python calculator + tests from scratch: 4 ops, divide-by-zero guard, no stubs, tests run',
    tags: ['create', 'from-scratch', 'python', 'stub-validator'],
    workspace: {
      'README.md': '# Calculator\n\nAn empty project — build the calculator here.\n',
    },
    userMessage:
      'Build a small Python calculator. Create calculator.py with four fully-implemented functions — ' +
      'add(a, b), subtract(a, b), multiply(a, b), and divide(a, b) — where divide raises ValueError on ' +
      'division by zero. Then write test_calculator.py with a test for each operation and one for the ' +
      'divide-by-zero case, run the tests, and make sure they pass. No placeholders or TODOs.',
    expect: {
      // Either tracked write tool. `edit_file` on a path that does not exist is
      // coerced into a create (a shim for llama3.2's call shape), so a model can
      // reach the same tracked, undoable result by that route. An untracked
      // shell heredoc still fails, which is what this assertion is for.
      toolsCalledAny: ['write_file', 'edit_file'],
      files: {
        exist: ['calculator.py', 'test_calculator.py'],
        contain: [
          { path: 'calculator.py', substrings: ['def add', 'def subtract', 'def multiply', 'def divide'] },
          { path: 'test_calculator.py', substrings: ['def test', 'divide'] },
        ],
        // The divide-by-zero guard is the one behavioral requirement we can
        // check statically.
        matchesRegex: [{ path: 'calculator.py', patterns: [/raise\s+ValueError/] }],
        notContain: [
          { path: 'calculator.py', substrings: ['TODO', 'FIXME', 'NotImplementedError', 'not implemented'] },
        ],
      },
    },
    // Running the tests is forced by the completion gate, but execution depends
    // on the eval host having python — keep it soft so a missing interpreter
    // doesn't mask the construction result.
    softExpect: {
      toolsCalledAny: ['run_command', 'run_tests'],
    },
  },

  {
    id: 'build-python-calculator-cli',
    description: 'Builds a runnable Python CLI calculator app from scratch and executes it to confirm it works',
    tags: ['create', 'from-scratch', 'python', 'cli'],
    workspace: {
      'README.md': '# Calculator CLI\n\nAn empty project — build the calculator app here.\n',
    },
    userMessage:
      'Build a command-line calculator app in calculator.py. It takes an operation and two numbers as ' +
      'command-line arguments — e.g. `python calculator.py add 2 3` prints 5 — supporting add, subtract, ' +
      'multiply, and divide. Division by zero must print a clear error instead of crashing. Run it on a ' +
      'couple of examples to confirm it works. Implement it fully — no placeholders.',
    expect: {
      // Either tracked write tool. `edit_file` on a path that does not exist is
      // coerced into a create (a shim for llama3.2's call shape), so a model can
      // reach the same tracked, undoable result by that route. An untracked
      // shell heredoc still fails, which is what this assertion is for.
      toolsCalledAny: ['write_file', 'edit_file'],
      files: {
        exist: ['calculator.py'],
        contain: [{ path: 'calculator.py', substrings: ['add', 'subtract', 'multiply', 'divide'] }],
        // Must be a real runnable CLI: a __main__ entry + argument handling.
        matchesRegex: [
          {
            path: 'calculator.py',
            patterns: [/if\s+__name__\s*==\s*['"]__main__['"]/, /argparse|sys\.argv/],
          },
        ],
        notContain: [
          { path: 'calculator.py', substrings: ['TODO', 'FIXME', 'NotImplementedError', 'not implemented'] },
        ],
      },
    },
    // The agent should actually run the app on an example to confirm it works
    // (the prompt asks for it; the completion gate reinforces it). Soft because
    // execution needs python on the eval host.
    softExpect: {
      toolsCalledAny: ['run_command'],
    },
  },
];
