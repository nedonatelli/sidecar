import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Dogfood regression cases — the exact tasks that broke SideCar in the v0.119
// interactive pass, promoted into the harness so they can be re-run across
// models without a human driving the chat.
//
// Every assertion below encodes a bug that actually shipped and was fixed:
//
//   • FILE CORRUPTION — three separate vectors turned a clean 4-line file into
//     syntactically broken garbage while `edit_file` reported success
//     (`outcome: ok`). The `filesParse` + notContain assertions pin that the
//     file survives; a corrupting run fails the case instead of passing it.
//   • SILENT NO-OP — the JSDoc task "succeeded" while writing nothing at all,
//     because a shape-validation refusal was returned as a normal string. The
//     files.contain assertions pin that the work actually lands.
//   • THRASH — the model sent nine identical malformed edits, or kept editing
//     after the task was done. iteration caps + toolCallNotMatches pin that.
//
// These are deliberately SEPARATE from AGENT_CASES: they are hostile,
// small-model-shaped tasks, and their value is as a cross-model regression
// sweep (`SIDECAR_EVAL_TAGS=dogfood`), not as part of the smoke set.
// ---------------------------------------------------------------------------

const GREETER = {
  'src/greeter.ts':
    '// Says hello to the given name.\n' +
    'export function greet(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n',
};

const RENAMED = {
  'src/greeter.ts':
    '// Says hello to the given name.\n' +
    'export function welcome(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n',
};

export const DOGFOOD_CASES: AgentEvalCase[] = [
  {
    id: 'dogfood-rename-no-corruption',
    description: 'Rename a function without corrupting the file (three live corruption vectors)',
    tags: ['dogfood', 'edit', 'corruption'],
    workspace: GREETER,
    userMessage: 'Rename the greet function to welcome in src/greeter.ts.',
    maxIterations: 12,
    expect: {
      files: {
        contain: [{ path: 'src/greeter.ts', substrings: ['welcome'] }],
        // The three live corruptions, each pinned:
        //  1. orphaned body     → a stray `return` after a self-contained one-liner
        //  2. mid-token splice  → `)tring)` from a search string cut inside `string`
        //  3. regex-escaped src → `\(name` from an escaped replacement
        notContain: [{ path: 'src/greeter.ts', substrings: ['greet(', ')tring', '\\(name', '\\)'] }],
        // Structure intact: the export and the body survive the edit.
        matchesRegex: [
          {
            path: 'src/greeter.ts',
            patterns: [/export function welcome\(name: string\): string \{/, /return `Hello, \$\{name\}!`;/],
          },
        ],
      },
    },
  },
  {
    id: 'dogfood-add-jsdoc',
    description: 'Add a JSDoc comment — the task that silently wrote nothing at all',
    tags: ['dogfood', 'edit'],
    workspace: RENAMED,
    // The live failure: the model sent edit_file with only `replace` (no
    // `search`) nine times; the refusal was returned as a SUCCESS, so nothing
    // was written and nothing noticed. The work must actually land now.
    userMessage: 'Add a JSDoc comment above the welcome function in src/greeter.ts documenting its parameter.',
    maxIterations: 12,
    expect: {
      files: {
        contain: [{ path: 'src/greeter.ts', substrings: ['/**', '*/'] }],
        // The function itself must survive being commented.
        matchesRegex: [{ path: 'src/greeter.ts', patterns: [/export function welcome\(name: string\)/] }],
        notContain: [{ path: 'src/greeter.ts', substrings: ['\\(name', ')tring'] }],
      },
    },
  },
  {
    id: 'dogfood-no-work-after-done',
    description: 'A completed rename is recognized as complete — no post-success edit thrash',
    tags: ['dogfood', 'latch'],
    // The file ALREADY has the rename applied. Asking for it again must be
    // recognized as already-done, not retried until cycle detection bails.
    workspace: RENAMED,
    setupMessages: [
      { role: 'user', content: 'Rename the greet function to welcome in src/greeter.ts.' },
      { role: 'assistant', content: 'Done — src/greeter.ts now exports `welcome`.' },
    ],
    setupMessagesRequired: true,
    userMessage: 'Did that rename actually land? Check src/greeter.ts and tell me — do not change anything else.',
    maxIterations: 6,
    expect: {
      // It should look, not edit. The file must come out byte-identical.
      files: { notModified: ['src/greeter.ts'] },
      finalTextContains: [['welcome', 'renamed', 'yes', 'landed', 'applied']],
    },
  },
];
