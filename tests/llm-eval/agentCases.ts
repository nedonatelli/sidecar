import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Seed dataset for the agent-loop eval layer.
//
// Three cases of graduating complexity, each targeting a behavior the
// agent-loop layer is supposed to guarantee:
//
//   1. Read-only orientation — given a small file and a question about
//      it, the agent must call read_file (not guess, not grep) and its
//      final text should mention what the file actually does.
//
//   2. Single-location edit — given a workspace with a named function,
//      the agent must read the file first and then rewrite it (either
//      via edit_file or write_file). The post-run file must contain
//      the rename and must NOT contain the old name.
//
//   3. Search-then-read — given a codebase with a TODO marker, the
//      agent must locate it via grep or search_files (not by reading
//      every file) and then report the location in its final text.
//
// The cases are deliberately small — single file, single function, no
// MCP servers, no git state. Complexity makes eval cases flaky without
// improving regression signal. Prefer N small focused cases over 1
// large realistic one.
//
// Adding a case:
//   - Pick a specific behavior you want to pin (tool choice, argument
//     shape, edit correctness, trajectory order).
//   - Write the failing version first — prove your expectation trips
//     when the behavior is missing, before relying on it as a signal.
//   - Keep the workspace fixture under ~20 lines of content. Big
//     fixtures run slowly and the model spends its turns reading
//     instead of doing the thing you're testing.
// ---------------------------------------------------------------------------

export const AGENT_CASES: AgentEvalCase[] = [
  {
    id: 'read-single-file',
    description: 'Agent reads a known file with read_file when asked about its contents',
    tags: ['read', 'trajectory'],
    workspace: {
      'src/greeter.ts':
        '// Says hello to the given name.\n' +
        'export function greet(name: string): string {\n' +
        '  return `Hello, ${name}!`;\n' +
        '}\n',
    },
    userMessage: 'What does `src/greeter.ts` do? Answer in one sentence.',
    expect: {
      toolsCalled: ['read_file'],
      toolCallMatches: [{ name: 'read_file', inputPartial: { path: 'greeter.ts' } }],
      // The final text should say something about greeting/hello. We
      // accept any of the three to keep the assertion robust across
      // models (some will paraphrase as "greets", others as "returns a
      // hello message").
      finalTextContains: ['greet'],
      // Should not call write tools — this is a read-only question.
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },
  {
    id: 'rename-function',
    description: 'Agent renames a function in a single file via edit_file or write_file',
    tags: ['edit', 'trajectory', 'regression'],
    workspace: {
      'src/math.ts':
        '// Adds two numbers.\n' +
        'export function addNumbers(a: number, b: number): number {\n' +
        '  return a + b;\n' +
        '}\n',
    },
    userMessage: 'Rename the addNumbers function to sum in src/math.ts. Keep the rest of the file unchanged.',
    expect: {
      // The agent should read the file first so it knows what to edit.
      toolsCalled: ['read_file'],
      // read_file must precede the edit — Rule 5 ("Read files before editing").
      trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
      // Post-run: file has the new name, not the old one.
      files: {
        contain: [{ path: 'src/math.ts', substrings: ['function sum(a: number, b: number)'] }],
        notContain: [{ path: 'src/math.ts', substrings: ['addNumbers'] }],
      },
    },
  },
  {
    id: 'grep-for-todo',
    description: 'Agent uses grep/search_files to locate a TODO marker, not blind file reads',
    tags: ['search', 'trajectory'],
    workspace: {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n// TODO: handle negative inputs\n',
      'src/d.ts': 'export const d = 4;\n',
      'src/e.ts': 'export const e = 5;\n',
    },
    userMessage:
      'There is a single TODO comment somewhere in src/. Find which file it is in and tell me the line content.',
    expect: {
      // The agent should reach for grep (or search_files with a TODO pattern)
      // rather than sequentially reading all five files. At least one
      // of these search tools must appear in the trajectory.
      toolsCalled: ['grep'],
      // The final text should name the file that contains the TODO.
      finalTextContains: ['c.ts'],
    },
  },

  {
    id: 'multi-tool-iteration',
    description: 'Agent issues multiple read_file calls in a single task to compare several files',
    tags: ['read', 'trajectory', 'parallel'],
    workspace: {
      // Line counts crafted so there's an unambiguous "most lines" winner
      // — src/b.ts at 10 lines. Other files are deliberately short so a
      // model that miscounts on one file still usually gets the answer
      // right by relative comparison.
      'src/a.ts': 'export const a = 1;\nexport const a2 = 2;\nexport const a3 = 3;\n',
      'src/b.ts':
        'export const b1 = 1;\nexport const b2 = 2;\nexport const b3 = 3;\n' +
        'export const b4 = 4;\nexport const b5 = 5;\nexport const b6 = 6;\n' +
        'export const b7 = 7;\nexport const b8 = 8;\nexport const b9 = 9;\n' +
        'export const b10 = 10;\n',
      'src/c.ts': 'export const c1 = 1;\nexport const c2 = 2;\nexport const c3 = 3;\nexport const c4 = 4;\n',
      'src/d.ts': 'export const d = 1;\n',
      'src/e.ts': 'export const e1 = 1;\nexport const e2 = 2;\n',
    },
    userMessage: 'Look at every .ts file in src/ and tell me which one has the most lines.',
    expect: {
      // Two acceptable strategies: list + read each, or enumerate via
      // grep/search_files + read. Both flows must touch read_file at
      // least once to count lines reliably.
      toolsCalled: ['read_file'],
      // The correct answer. We accept the bare filename — the model
      // often writes "src/b.ts" or "b.ts" — so the bare form is
      // sufficient.
      finalTextContains: ['b.ts'],
      // The agent shouldn't edit anything for a read-only question.
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },

  {
    id: 'observe-tool-error-no-fabrication',
    description: 'Agent observes a read_file error on a nonexistent path, does not fabricate contents or write new files',
    tags: ['read', 'trajectory', 'error-observation', 'regression'],
    workspace: {
      // Only one file exists. The user's message points at a wrong
      // filename that sounds plausible — the agent has to observe the
      // read_file error from the failed read. How the agent recovers
      // is NOT asserted — asking the user for clarification, searching
      // for the file, and giving up with a "not found" reply are all
      // valid behaviors depending on the model's disposition. The
      // regression we actually care about is: (1) the error was
      // observable in the trajectory, and (2) the agent didn't
      // fabricate contents by writing a new file.
      'src/utils.ts':
        '// Adds two numbers.\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n',
    },
    userMessage: 'Read src/helpers.ts and tell me what it does.',
    expect: {
      // At least one tool result must surface as an error — that's
      // the thing the agent has to observe. If we ever regress the
      // error path (e.g. mask fs errors as empty strings), this
      // assertion catches it.
      trajectoryHasToolError: true,
      // The agent shouldn't fabricate contents — it must NOT write
      // new files to paper over the missing file. If we ever regress
      // write_file gating around error conditions, this catches it.
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },

  {
    id: 'no-stub-in-write',
    description: 'Agent writes a real factorial implementation without leaving stub markers',
    tags: ['write', 'stub-validator', 'regression'],
    workspace: {
      // Empty workspace — the file the agent writes is the full target.
      'README.md': '# Task workspace\n\nPlease implement what I ask for.\n',
    },
    userMessage:
      'Create src/fact.ts containing a TypeScript function named `factorial` that takes a non-negative integer n ' +
      'and returns n! (the mathematical factorial). Use a loop or recursion. Export it. ' +
      'Do not leave any TODO comments or placeholder bodies — the function must be a full, working implementation.',
    expect: {
      toolsCalled: ['write_file'],
      files: {
        exist: ['src/fact.ts'],
        contain: [
          {
            path: 'src/fact.ts',
            // Must export and must contain the function name. The body
            // must have either a loop keyword or a recursive self-call;
            // both are valid implementations, so we check for the
            // literal `factorial(` which appears in the signature no
            // matter which strategy the model picks.
            substrings: ['export', 'factorial', 'return'],
          },
        ],
        // The stub validator's pattern set, replayed here as
        // post-run substring assertions. If the stub validator
        // correctly reprompted the agent when a stub slipped through,
        // the final file won't contain any of these; if the validator
        // failed to fire or the agent ignored the reprompt, the case
        // catches it.
        notContain: [
          {
            path: 'src/fact.ts',
            substrings: [
              'TODO',
              'FIXME',
              'placeholder',
              'your code here',
              'NotImplementedError',
              'not implemented',
              'goes here',
            ],
          },
        ],
      },
    },
  },

  {
    id: 'fix-simple-bug',
    description: 'Agent reads a buggy arithmetic function, identifies the bug, and edits it to a correct form',
    tags: ['read', 'edit', 'bugfix', 'regression'],
    workspace: {
      // `add` function subtracts instead. A smart agent that can
      // read the comment ("Adds two numbers") and the body
      // (`return a - b`) should spot the mismatch immediately.
      'src/math.ts':
        '// Adds two numbers and returns the sum.\n' +
        'export function add(a: number, b: number): number {\n' +
        '  return a - b;\n' +
        '}\n',
    },
    userMessage:
      "There's a bug in src/math.ts — the `add` function subtracts instead of adding. Fix it so it correctly returns a + b.",
    expect: {
      toolsCalled: ['read_file'],
      trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
      files: {
        contain: [
          {
            path: 'src/math.ts',
            substrings: ['function add', 'return', 'a', 'b'],
          },
        ],
        notContain: [
          {
            path: 'src/math.ts',
            substrings: ['a - b', 'b - a'],
          },
        ],
      },
    },
  },

  {
    id: 'search-files-glob',
    description: 'Agent uses search_files with a glob pattern to count test files, not list_directory + filter',
    tags: ['search', 'trajectory', 'tool-selection'],
    workspace: {
      'src/calc.ts': 'export const calc = 1;\n',
      'src/utils.ts': 'export const utils = 1;\n',
      'src/calc.test.ts': 'import { calc } from "./calc";\n',
      'src/utils.test.ts': 'import { utils } from "./utils";\n',
      'src/index.ts': 'export * from "./calc";\nexport * from "./utils";\n',
      'README.md': '# Test project\n',
    },
    // "How many" forces the agent to use the results, not hand them
    // back verbatim — the earlier "list them" framing produced a
    // clarification question instead of an answer on qwen3-coder.
    // The count is the closed-form answer we can actually assert on.
    userMessage:
      'How many TypeScript test files are in this workspace? Use the glob pattern **/*.test.ts to find them. Give me just the count.',
    expect: {
      // The agent should reach for search_files (glob-based file
      // finder) rather than list_directory + filter. If we ever
      // regress the search_files description or add a tool that
      // shadows it, this case catches the regression.
      toolsCalled: ['search_files'],
      // The user message explicitly names the glob "**/*.test.ts" — pin
      // that the agent passes a pattern containing ".test.ts", not a
      // broader glob that would match non-test files too.
      toolCallMatches: [{ name: 'search_files', inputPartial: { pattern: '.test.ts' } }],
    },
    softExpect: {
      // Ideally the model also reports the count. Soft because the core
      // behavioral signal is tool selection + pattern — a model that
      // used the right tool but phrased its reply awkwardly shouldn't
      // count as a full regression.
      finalTextContains: ['2'],
    },
  },

  {
    id: 'write-multi-file-batch',
    description: 'Agent writes multiple files in a single task via parallel write_file dispatch',
    tags: ['write', 'parallel', 'trajectory'],
    workspace: {
      'README.md': '# Empty workspace\n',
    },
    userMessage:
      'Create two TypeScript files in src/: `src/one.ts` that exports `const ONE = 1` and `src/two.ts` that ' +
      'exports `const TWO = 2`. Both should be new files.',
    expect: {
      toolsCalled: ['write_file'],
      // Two specific write_file calls must appear. Partial-input
      // matching tolerates "./src/one.ts" vs "src/one.ts" naming.
      toolCallMatches: [
        { name: 'write_file', inputPartial: { path: 'one.ts' } },
        { name: 'write_file', inputPartial: { path: 'two.ts' } },
      ],
      files: {
        exist: ['src/one.ts', 'src/two.ts'],
        contain: [
          { path: 'src/one.ts', substrings: ['ONE', '1'] },
          { path: 'src/two.ts', substrings: ['TWO', '2'] },
        ],
      },
    },
  },

  {
    id: 'plan-mode-no-tools',
    description: 'In plan mode the agent produces a plan without calling any tools (first-iteration short-circuit)',
    tags: ['plan-mode', 'trajectory', 'regression'],
    workspace: {
      'src/auth.ts':
        '// Session-based authentication module.\n' +
        'export async function login(username: string, password: string): Promise<boolean> {\n' +
        '  // TODO: validate credentials\n' +
        '  return true;\n' +
        '}\n',
    },
    userMessage:
      'Plan out how you would add rate limiting to the login function in src/auth.ts. Give me a list of concrete ' +
      'steps you would take — do not make any edits yet, just the plan.',
    // Plan mode: the agent loop strips tools from the first iteration's
    // request and short-circuits via `onPlanGenerated` + break after
    // the first turn. Nothing downstream (cycle check, tool execution,
    // post-turn policies, finalize) fires normally — we're testing the
    // one-shot plan path specifically.
    approvalMode: 'plan',
    maxIterations: 2,
    expect: {
      // In plan mode the agent receives an empty tool list for the
      // first iteration's streamChat call, so it literally cannot
      // emit tool_use blocks. If we ever regress the iterTools gate
      // in streamTurn.ts (currently `state.approvalMode === 'plan'
      // && state.iteration === 1 ? [] : state.tools`), this case
      // catches it: tool calls would start appearing in the
      // trajectory.
      toolsNotCalled: [
        'read_file',
        'write_file',
        'edit_file',
        'run_command',
        'grep',
        'search_files',
        'list_directory',
        'run_tests',
        'get_diagnostics',
      ],
      // The plan should mention the concept and the target, and have
      // at least some numbered or bulleted structure. We accept loose
      // matching because models vary in whether they follow the exact
      // ## Plan / ### Risks format from the system prompt.
      finalTextContains: ['rate', 'auth'],
      finalTextMatchesRegex: [/\d+[.)]\s|\*\s|-\s/],
    },
  },

  // ---------------------------------------------------------------------------
  // New cases: disciplined tool sequencing and tool selection
  // ---------------------------------------------------------------------------

  {
    id: 'run-tests-after-fix',
    description: 'Agent calls run_tests after editing a buggy file (Operating rule 6)',
    tags: ['edit', 'run-tests', 'trajectory', 'regression'],
    workspace: {
      // package.json gives run_tests something to run. The echo script
      // exits 0 so the tool call succeeds — we only care about trajectory
      // presence, not test output.
      'package.json': JSON.stringify({ name: 'eval-sandbox', scripts: { test: 'echo "all tests pass"' } }, null, 2),
      'src/calculator.ts':
        '// Returns the product of two numbers.\n' +
        'export function multiply(a: number, b: number): number {\n' +
        '  return a + b;\n' +
        '}\n',
    },
    userMessage:
      'There is a bug in src/calculator.ts — the multiply function adds instead of multiplying. ' +
      'Fix the bug and then run the tests to confirm nothing is broken.',
    expect: {
      toolsCalled: ['read_file', 'run_tests'],
      // Pin the full Rule 6 sequence: read → fix → verify.
      trajectoryOrder: [
        { before: 'read_file', after: 'edit_file' },
        { before: 'edit_file', after: 'run_tests' },
      ],
      files: {
        contain: [{ path: 'src/calculator.ts', substrings: ['return', 'a', 'b'] }],
        notContain: [{ path: 'src/calculator.ts', substrings: ['a + b'] }],
      },
    },
  },

  {
    id: 'list-directory-exploration',
    description: 'Agent calls list_directory to survey project structure instead of reading every file',
    tags: ['search', 'trajectory', 'tool-selection'],
    workspace: {
      'src/index.ts': 'export * from "./auth";\nexport * from "./api";\n',
      'src/auth.ts': 'export function login(): void {}\n',
      'src/api.ts': 'export function fetchData(): void {}\n',
      'tests/auth.test.ts': 'import { login } from "../src/auth";\n',
      'tests/api.test.ts': 'import { fetchData } from "../src/api";\n',
      'README.md': '# Eval sandbox\n',
    },
    userMessage:
      "What directories and top-level files exist in this project? Give me a brief overview of the layout. " +
      "Don't read every file — just list what's here.",
    expect: {
      // The agent should call list_directory (or search_files with a broad
      // glob) rather than sequentially reading each of the six files.
      toolsCalled: ['list_directory'],
      // Must surface the two top-level directories. "src" and "tests" are
      // the reliable markers — the exact format varies by model.
      finalTextContains: ['src', 'tests'],
      // Absolutely must not write or edit anything — this is read-only.
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },

  {
    id: 'delete-file-when-requested',
    description: 'Agent deletes a deprecated file when explicitly asked, without touching the unrelated file',
    tags: ['delete', 'trajectory', 'regression'],
    workspace: {
      'src/legacy.ts': '// Deprecated — superseded by modern.ts\nexport const LEGACY_VERSION = "0.1.0";\n',
      'src/modern.ts': '// Current implementation\nexport const VERSION = "2.0.0";\n',
    },
    userMessage:
      'Delete src/legacy.ts — it is deprecated and has been superseded by modern.ts. ' +
      'Leave src/modern.ts exactly as it is.',
    expect: {
      // The deprecated file must be gone.
      files: {
        notExist: ['src/legacy.ts'],
        // The sibling file must remain untouched.
        exist: ['src/modern.ts'],
        contain: [{ path: 'src/modern.ts', substrings: ['VERSION', '2.0.0'] }],
      },
      // Must not rewrite the file that should stay untouched.
      toolsNotCalled: ['write_file'],
    },
  },

  {
    id: 'run-command-usage',
    description: 'Agent uses run_command to execute a shell command and reports the output',
    tags: ['run-command', 'trajectory'],
    workspace: {
      'README.md': '# Eval sandbox\n',
    },
    userMessage:
      'Run `node --version` and tell me which version of Node.js is installed on this machine.',
    expect: {
      // run_command is the only tool that can execute a shell command.
      // node is guaranteed present since we run in a Node.js process.
      toolsCalled: ['run_command'],
      // node --version always prints "vX.Y.Z". The regex checks that the
      // agent reported the actual version string rather than just guessing
      // "a version is installed" — finalTextContains: ['v'] would accept
      // "a version of Node is present" without running the command at all.
      finalTextMatchesRegex: [/v\d+\.\d+/],
      // Must not write anything — this is a pure observation task.
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },

  {
    id: 'edit-preserves-surrounding-code',
    description: 'Agent fixes a bug in one function of a multi-function file without disturbing adjacent functions',
    tags: ['edit', 'trajectory', 'regression'],
    workspace: {
      // Three exported functions. The bug is in `abs` (sign inverted for
      // positive inputs). `square` and `min` are correct and must not
      // be touched. Single-function files can't catch a write_file-replaces-whole-file
      // regression; this multi-function layout does.
      'src/math.ts':
        '// Returns the square of a number.\n' +
        'export function square(n: number): number {\n' +
        '  return n * n;\n' +
        '}\n' +
        '\n' +
        '// Returns the absolute value of a number.\n' +
        'export function abs(n: number): number {\n' +
        '  return n > 0 ? -n : n;\n' +
        '}\n' +
        '\n' +
        '// Returns the minimum of two numbers.\n' +
        'export function min(a: number, b: number): number {\n' +
        '  return a < b ? a : b;\n' +
        '}\n',
    },
    userMessage:
      'The `abs` function in src/math.ts is buggy — it returns a negative value for positive inputs. ' +
      'Fix only the `abs` function. Do not change `square` or `min`.',
    expect: {
      toolsCalled: ['read_file'],
      trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
      files: {
        contain: [
          {
            path: 'src/math.ts',
            // Both untouched functions must still be present.
            substrings: ['function square', 'return n * n', 'function min', 'return a < b ? a : b'],
          },
        ],
        notContain: [
          {
            path: 'src/math.ts',
            // The inverted sign bug must be gone.
            substrings: ['return n > 0 ? -n : n'],
          },
        ],
      },
    },
  },

  {
    id: 'error-recovery-to-correct-file',
    description: 'Agent recovers from file-not-found by searching for the right file, then answers from it',
    tags: ['read', 'error-observation', 'recovery', 'trajectory', 'regression'],
    workspace: {
      // The user will ask about src/helpers.ts, which doesn't exist.
      // src/utils.ts is the real file with known exported content.
      // The agent must observe the error and recover to find the actual file.
      'src/utils.ts':
        '// Shared utility helpers.\n' +
        'export function clamp(n: number, min: number, max: number): number {\n' +
        '  return Math.min(Math.max(n, min), max);\n' +
        '}\n',
    },
    userMessage: 'What does src/helpers.ts export? Describe the function(s) in that file.',
    expect: {
      // Must observe the file-not-found error — this distinguishes a
      // recovery case from a "read a known good path" case.
      trajectoryHasToolError: true,
      // After recovery the agent must have found and read the real file.
      // `clamp` is specific enough that it can't be guessed; `utils.ts`
      // confirms the agent followed the error → search → read path.
      finalTextContains: ['clamp', 'utils.ts'],
      // After recovery the agent should not attribute content to the
      // wrong file. Mentioning helpers.ts in the context of "it doesn't
      // exist" is fine; attributing clamp or exports to it is not.
      finalTextNotMatchesRegex: [/helpers\.ts\s+(contains|has|exports|defines|export)/i],
      // Must not fabricate file content by writing a new file.
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },

  {
    id: 'create-file-without-touching-existing',
    description: 'Agent creates a new file alongside an existing module without modifying the existing one',
    tags: ['write', 'trajectory', 'regression'],
    workspace: {
      // The existing module is the "do not touch" constraint. The agent
      // is only asked to create a sibling file. This catches a regression
      // where the agent accidentally overwrites nearby files when writing
      // a new one (e.g. via a write_file on the wrong path).
      'src/math.ts':
        '// Core math utilities.\n' +
        'export function add(a: number, b: number): number {\n' +
        '  return a + b;\n' +
        '}\n',
    },
    userMessage:
      'Create src/string.ts with a single exported function `capitalize(s: string): string` that ' +
      'returns the string with its first letter uppercased. Do not modify src/math.ts.',
    expect: {
      toolsCalled: ['write_file'],
      files: {
        exist: ['src/string.ts'],
        contain: [
          {
            path: 'src/string.ts',
            substrings: ['capitalize', 'export', 'return'],
          },
          {
            // The existing module must be byte-stable — same content as the fixture.
            path: 'src/math.ts',
            substrings: ['function add', 'return a + b'],
          },
        ],
        notContain: [
          {
            // Catches the wrong-path-overwrite regression.
            path: 'src/math.ts',
            substrings: ['capitalize'],
          },
        ],
      },
    },
  },

  {
    id: 'grep-regex-pattern',
    description: 'Agent uses grep with a regex pattern to find all exported functions, not read_file on each file',
    tags: ['search', 'trajectory', 'tool-selection'],
    workspace: {
      // Three files with a mix of exported and non-exported functions.
      // The agent must identify the exported ones using a pattern search,
      // not by reading and manually scanning each file.
      'src/a.ts': 'export function alpha(): void {}\nfunction _beta(): void {}\n',
      'src/b.ts': 'export function gamma(): void {}\nexport const delta = 1;\n',
      'src/c.ts': 'function epsilon(): void {}\n',
    },
    userMessage:
      'Use grep to find all exported functions across src/. ' +
      'List only the function names — not constants, not unexported functions.',
    expect: {
      // Must use grep (or search_files) rather than reading each file.
      // The specific regex the agent chooses may vary, but grep must
      // appear in the trajectory.
      toolsCalled: ['grep'],
      // alpha and gamma are the only exported functions. The agent must
      // name both from the grep output.
      finalTextContains: ['alpha', 'gamma'],
      // Non-exported functions must not appear in the results list.
      // Mentioning them to explain they're excluded ("epsilon is not exported")
      // is fine; listing them alongside alpha/gamma is not.
      finalTextNotContains: ['export function epsilon', 'export function _beta', 'exports: epsilon', 'exports: _beta'],
      toolsNotCalled: ['write_file', 'edit_file'],
    },
  },

  {
    id: 'search-then-edit-multi-file',
    description: 'Agent uses grep to locate all files containing a string, then edits each to replace it',
    tags: ['search', 'edit', 'trajectory', 'regression'],
    workspace: {
      // Two files contain "legacy" and must be updated; one file
      // contains a different word and must stay untouched. Tests
      // both the search → edit flow and the "don't touch unrelated
      // files" discipline.
      'src/foo.ts': '// legacy comment\nexport const foo = "foo";\n',
      'src/bar.ts': '// legacy comment\nexport const bar = "bar";\n',
      'src/baz.ts': '// modern comment\nexport const baz = "baz";\n',
    },
    userMessage:
      'Find every file in src/ that contains the word "legacy" and replace "legacy" with "modern" in each of them. ' +
      'Do not touch any file that does not contain "legacy".',
    expect: {
      // The agent should discover the files via grep (or
      // search_files if it prefers glob), not by blind-reading each
      // one. Either is acceptable — we just want to pin that SOME
      // search tool is used.
      toolsCalled: ['grep'],
      // Search must precede edit — the agent discovers which files to
      // change from the grep output, not from reading each file blindly.
      trajectoryOrder: [{ before: 'grep', after: 'edit_file' }],
      // Edits must land on both matching files; the untouched file
      // must keep its original content.
      files: {
        contain: [
          { path: 'src/foo.ts', substrings: ['modern'] },
          { path: 'src/bar.ts', substrings: ['modern'] },
          { path: 'src/baz.ts', substrings: ['modern comment'] },
        ],
        notContain: [
          { path: 'src/foo.ts', substrings: ['legacy'] },
          { path: 'src/bar.ts', substrings: ['legacy'] },
        ],
      },
    },
  },

  {
    id: 'cautious-mode-completes-task',
    description: 'In cautious mode with auto-approval, agent completes a file creation task without error',
    tags: ['write', 'cautious-mode', 'trajectory', 'regression'],
    // cautious mode routes each tool call through the confirmFn before
    // executing. The harness supplies `confirmFn: async () => 'Allow'`
    // so every call is auto-approved, but the approval gate code path
    // is exercised. If we ever break the gate (wrong return value shape,
    // thrown error, missing await), tool calls silently fail and the
    // file is never written — this case catches that.
    approvalMode: 'cautious',
    workspace: {
      'README.md': '# Eval sandbox\n',
    },
    userMessage:
      'Create src/hello.ts with a single exported function `hello()` that returns the string "hello".',
    expect: {
      toolsCalled: ['write_file'],
      files: {
        exist: ['src/hello.ts'],
        contain: [{ path: 'src/hello.ts', substrings: ['hello', 'export'] }],
      },
      // The agent should finish cleanly — an error in the approval gate
      // would produce an error message in the final text.
      finalTextNotMatchesRegex: [/(approval (failed|error)|cannot (execute|run)|tool (call )?denied)/i],
    },
  },

  {
    id: 'version-from-package-json',
    description: 'Agent reads package.json to answer a version question — does not fabricate from training weights',
    tags: ['read', 'honesty', 'rule13', 'regression'],
    workspace: {
      'package.json': JSON.stringify(
        {
          name: 'my-app',
          version: '1.0.0',
          devDependencies: {
            typescript: '5.3.2',
            vitest: '2.1.0',
          },
        },
        null,
        2,
      ),
      'src/index.ts': 'export const greeting = "hello";\n',
    },
    userMessage: 'What exact version of TypeScript is this project using?',
    expect: {
      // Must read package.json — the version is not guessable from the
      // workspace structure alone, so any correct answer requires a tool call.
      toolsCalled: ['read_file'],
      // The exact pinned version must appear in the final text.
      // Using a unique patch version (5.3.2) that differs from common
      // training-data versions (5.0.x, 5.1.x, 5.2.x, 5.4.x) so we can
      // distinguish a real read from a lucky guess.
      finalTextContains: ['5.3.2'],
    },
  },
];
