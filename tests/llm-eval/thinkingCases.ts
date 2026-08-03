import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Reasoning eval cases: problems that require multi-step deduction.
//
// These cases are designed to distinguish models that reason through a
// problem from models that pattern-match against training data. Each
// case has a bug that is syntactically plausible, passes naive eyeballing,
// and fails only when the model thinks through the semantics.
//
// All cases use `softExpect: { trajectoryHasThinking: true }` so that:
//   - Thinking-capable models (DeepSeek-R1, QwQ, Claude extended thinking)
//     are checked for actual thinking events in the trajectory.
//   - Non-thinking models still get evaluated on correctness — the soft
//     assertion does not affect pass/fail.
//
// Case taxonomy:
//   - cross-file-causality: bug is in the caller, not the callee
//   - semantic-version-compare: lexicographic vs. numeric comparison
//   - missing-await-in-loop: Promise stored instead of resolved value
//   - aliased-mutation: Object.assign mutates a shared singleton
//
// Authoring notes:
//   - Workspaces stay under 25 lines total so model spends its tokens
//     reasoning, not reading scaffolding.
//   - Use softExpect for answer-quality checks (exact fixed line) so a
//     model that fixes the bug a slightly different way still passes.
//   - Each case asserts the correct file is edited and the wrong file
//     is NOT edited, because misattributing the bug is as bad as not
//     fixing it.
// ---------------------------------------------------------------------------

export const THINKING_CASES: AgentEvalCase[] = [
  {
    id: 'thinking-cross-file-causality',
    description:
      'Bug is in the caller (args swapped), not the callee — model must read both files and fix the right one',
    tags: ['edit', 'reasoning', 'multi-file'],
    workspace: {
      'src/utils.ts':
        '// Formats a monetary amount.\n' +
        'export function formatCurrency(amount: number, currency: string): string {\n' +
        '  return `${currency}${amount.toFixed(2)}`;\n' +
        '}\n',
      'src/app.ts':
        "import { formatCurrency } from './utils.js';\n" +
        '\n' +
        '// Returns a display string for a product price.\n' +
        'export function displayPrice(currency: string, amount: number): string {\n' +
        '  return formatCurrency(currency, amount);\n' +
        '}\n',
    },
    userMessage:
      'The `displayPrice` function in src/app.ts is returning garbled output like "5USD.00" instead of "USD5.00". ' +
      'Read src/utils.ts and src/app.ts, identify the argument order mismatch, then fix src/app.ts. ' +
      'Do not write test files. Do not change src/utils.ts.',
    expect: {
      // Either tracked write tool. The file-outcome assertions below decide
      // correctness; which write route reached it is not what this case
      // measures, and whole-file rewrite is a supported strategy.
      toolsCalledAny: ['edit_file', 'write_file'],
      // Must read both files to understand the signature mismatch.
      toolCallMatches: [
        { name: 'read_file', inputPartial: { path: 'utils.ts' } },
        { name: 'read_file', inputPartial: { path: 'app.ts' } },
      ],
      // Fix must be in app.ts: args corrected to (amount, currency).
      files: {
        contain: [{ path: 'src/app.ts', substrings: ['formatCurrency(amount, currency)'] }],
        // utils.ts must remain untouched — the bug is in the caller.
        equal: [
          {
            path: 'src/utils.ts',
            content:
              '// Formats a monetary amount.\n' +
              'export function formatCurrency(amount: number, currency: string): string {\n' +
              '  return `${currency}${amount.toFixed(2)}`;\n' +
              '}\n',
          },
        ],
      },
    },
    softExpect: {
      trajectoryHasThinking: true,
    },
  },

  {
    id: 'thinking-semantic-version-compare',
    description:
      'String comparison used for semver — "10.0.0" < "9.0.0" lexicographically; model must reason through why and fix it',
    tags: ['edit', 'reasoning', 'semantics'],
    workspace: {
      'src/version.ts':
        '/**\n' +
        ' * Returns true if `version` is greater than or equal to `minimum`.\n' +
        ' * Both arguments are semver strings like "1.2.3".\n' +
        ' */\n' +
        'export function isAtLeast(version: string, minimum: string): boolean {\n' +
        '  return version >= minimum;\n' +
        '}\n',
    },
    userMessage:
      '`isAtLeast("10.0.0", "9.0.0")` returns false, but it should return true. ' +
      'Fix the bug in src/version.ts so that version comparison is numeric, not lexicographic.',
    expect: {
      // Either tracked write tool. The file-outcome assertions below decide
      // correctness; which write route reached it is not what this case
      // measures, and whole-file rewrite is a supported strategy.
      toolsCalledAny: ['edit_file', 'write_file'],
      files: {
        // Fix must use numeric comparison — split on "." and compare numbers.
        matchesRegex: [
          {
            path: 'src/version.ts',
            patterns: [/split\s*\(\s*['"]\.['"]|parseInt|Number\s*\(|semver/],
          },
        ],
        // The naive string comparison must be gone.
        notContain: [{ path: 'src/version.ts', substrings: ['return version >= minimum'] }],
      },
    },
    softExpect: {
      trajectoryHasThinking: true,
      // Answer-quality: final text should explain the lexicographic vs. numeric issue.
      finalTextContains: ['lexicograph', 'numeric'],
    },
  },

  {
    id: 'thinking-missing-await-in-loop',
    description:
      'Missing await inside a for-loop pushes Promise objects instead of resolved strings — model must identify and fix all occurrences',
    tags: ['edit', 'reasoning', 'async'],
    workspace: {
      'src/downloader.ts':
        '/**\n' +
        ' * Fetches each URL in order and returns the response bodies.\n' +
        ' */\n' +
        'export async function downloadAll(\n' +
        '  urls: string[],\n' +
        '  fetch: (url: string) => Promise<string>,\n' +
        '): Promise<string[]> {\n' +
        '  const results: string[] = [];\n' +
        '  for (const url of urls) {\n' +
        '    results.push(fetch(url));\n' +
        '  }\n' +
        '  return results;\n' +
        '}\n',
    },
    userMessage:
      'The `downloadAll` function in src/downloader.ts returns an array of Promise objects instead of resolved strings. Fix the bug.',
    expect: {
      // Either tracked write tool. The file-outcome assertions below decide
      // correctness; which write route reached it is not what this case
      // measures, and whole-file rewrite is a supported strategy.
      toolsCalledAny: ['edit_file', 'write_file'],
      files: {
        contain: [{ path: 'src/downloader.ts', substrings: ['await fetch(url)'] }],
        notContain: [
          // The un-awaited call must be gone.
          { path: 'src/downloader.ts', substrings: ['results.push(fetch(url))'] },
        ],
      },
    },
    softExpect: {
      trajectoryHasThinking: true,
    },
  },

  {
    id: 'thinking-aliased-mutation',
    description:
      'Object.assign mutates the shared DEFAULTS singleton — model must reason about object aliasing and fix to spread into a new object',
    tags: ['edit', 'reasoning', 'state'],
    workspace: {
      'src/settings.ts':
        'const DEFAULTS = { timeout: 5000, retries: 3, verbose: false };\n' +
        '\n' +
        '/**\n' +
        ' * Returns a settings object with caller-supplied overrides merged over defaults.\n' +
        ' * DEFAULTS must not be mutated between calls.\n' +
        ' */\n' +
        'export function getSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {\n' +
        '  return Object.assign(DEFAULTS, overrides);\n' +
        '}\n',
    },
    userMessage:
      'After the first call to `getSettings({ verbose: true })`, every subsequent call to `getSettings()` ' +
      'returns `{ verbose: true, ... }` even with no overrides. Fix the bug in src/settings.ts.',
    expect: {
      // Either tracked write tool. The file-outcome assertions below decide
      // correctness; which write route reached it is not what this case
      // measures, and whole-file rewrite is a supported strategy.
      toolsCalledAny: ['edit_file', 'write_file'],
      files: {
        // Fix must spread DEFAULTS into a new object, not mutate it.
        matchesRegex: [
          {
            path: 'src/settings.ts',
            patterns: [/Object\.assign\(\s*\{\s*\}|Object\.assign\(\{\}|\.\.\.\s*DEFAULTS|\{\s*\.\.\.\s*DEFAULTS/],
          },
        ],
        notContain: [
          // The mutating form must be gone.
          { path: 'src/settings.ts', substrings: ['Object.assign(DEFAULTS,'] },
        ],
      },
    },
    softExpect: {
      trajectoryHasThinking: true,
      // Answer-quality: explanation should mention mutation or aliasing.
      finalTextContains: ['mutat'],
    },
  },
];
