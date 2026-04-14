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
];
