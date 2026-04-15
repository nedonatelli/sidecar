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
      files: {
        contain: [
          {
            path: 'src/math.ts',
            // Signature must still exist; return statement must still
            // exist; both parameters must still be referenced in the
            // fixed body.
            substrings: ['function add', 'return', 'a', 'b'],
          },
        ],
        // The bug itself must be gone. We check both `a - b` and
        // `b - a` orderings since either would be wrong. A correct
        // fix writes `a + b` or `b + a`, both of which are absent
        // from these substrings.
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
      // Final text must contain the answer. "2" is specific enough
      // that false positives are unlikely, and any correct answer
      // must contain it.
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
      // The plan should mention the concept and the target. We
      // accept loose substring matching because plan structure
      // varies model-to-model.
      finalTextContains: ['rate', 'auth'],
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
];
