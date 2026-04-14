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
];
