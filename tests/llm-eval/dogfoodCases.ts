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

/**
 * A realistic-size file: 120 functions, ~600 lines. Every edit_file call now
 * parses the whole file (twice — before and after) to enforce the syntax
 * invariant. That was measured at 0.1ms on a 4-line fixture; this case proves
 * the guards do not blow up latency, or bail via their 10s timeout, on a file
 * of the size people actually edit. A timeout would silently disable the guard.
 */
const BIG_FILE = (() => {
  const fns = Array.from(
    { length: 120 },
    (_, i) =>
      `/** Computes step ${i}. */\nexport function step${i}(value: number): number {\n  return value + ${i};\n}\n`,
  ).join('\n');
  return `// Auto-generated pipeline steps.\n\n${fns}\nexport const TOTAL_STEPS = 120;\n`;
})();

export const DOGFOOD_LANGUAGE_AND_SCALE_CASES: AgentEvalCase[] = [
  {
    id: 'dogfood-python-syntax-guard',
    description: 'Python edit — the syntax guard must protect more than TypeScript',
    tags: ['dogfood', 'edit', 'corruption', 'python'],
    // The edit-time syntax guard ships 19 tree-sitter grammars but was only ever
    // verified end-to-end on TypeScript. Python is the language the ORIGINAL
    // completion-time syntax gate was built for (an agent shipped a .py file with
    // a syntax error), so it is the one that most needs to hold.
    workspace: {
      'src/greeter.py':
        '"""Greeting helpers."""\n\n\n' +
        'def greet(name: str) -> str:\n' +
        '    """Say hello to the given name."""\n' +
        '    return f"Hello, {name}!"\n',
    },
    userMessage: 'Rename the greet function to welcome in src/greeter.py.',
    maxIterations: 12,
    expect: {
      files: {
        contain: [{ path: 'src/greeter.py', substrings: ['def welcome(name: str) -> str:'] }],
        notContain: [
          // Corruption signatures: the old name surviving, an orphaned body, a
          // mid-token splice, or escaped source (all seen live on TypeScript).
          { path: 'src/greeter.py', substrings: ['def greet(', '\\(name', ')tr:'] },
        ],
        // The body and the docstring must survive the rename, and indentation
        // (which IS syntax in Python) must stay intact.
        matchesRegex: [
          {
            path: 'src/greeter.py',
            patterns: [/def welcome\(name: str\) -> str:\n\s{4}"""/, /\n\s{4}return f"Hello, \{name\}!"/],
          },
        ],
      },
    },
  },
  {
    id: 'dogfood-large-file-edit',
    description: 'Edit one function in a ~600-line file — guards must not stall or time out',
    tags: ['dogfood', 'edit', 'scale'],
    workspace: { 'src/pipeline.ts': BIG_FILE },
    userMessage:
      'In src/pipeline.ts, change the step47 function so it returns value * 47 instead of value + 47. Change nothing else.',
    maxIterations: 12,
    expect: {
      files: {
        contain: [{ path: 'src/pipeline.ts', substrings: ['return value * 47;'] }],
        // The surgical edit must not disturb its neighbours — a guard that
        // times out (silently disabling itself) or an inference that fires on
        // the wrong window would show up here.
        matchesRegex: [
          {
            path: 'src/pipeline.ts',
            patterns: [
              /export function step46\(value: number\): number \{\n  return value \+ 46;/,
              /export function step48\(value: number\): number \{\n  return value \+ 48;/,
              /export const TOTAL_STEPS = 120;/,
            ],
          },
        ],
      },
    },
  },
];
