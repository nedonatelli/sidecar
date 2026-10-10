import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Cases in a project whose checker IS installed.
//
// Every other fixture is a handful of files with no node_modules, so every
// eval run exercised the "no checker available" path and none exercised the
// ordinary one. The completion gate treats them differently: with tsc
// installed it must still demand a real type-check after an edit, not accept
// a clean parse. These cases pin that path, and that verifying never touches
// the project's own config.
//
// `npm install` runs from the fixture's package.json (cached after the first
// run). Setup commands go through cmd.exe on Windows, so no single quotes.
// ---------------------------------------------------------------------------

const TS_PROJECT = {
  'package.json':
    JSON.stringify(
      {
        name: 'tooling-installed-fixture',
        version: '1.0.0',
        private: true,
        scripts: { typecheck: 'tsc --noEmit' },
        devDependencies: { typescript: '^5.6.0' },
      },
      null,
      2,
    ) + '\n',
  'tsconfig.json':
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',
};

const INSTALL = ['npm install --no-audit --no-fund --prefer-offline --loglevel=error'];

/** Verifying an edit must never rewrite the project's own config. */
const CONFIG_UNTOUCHED = ['package.json', 'tsconfig.json'];

export const TOOLING_INSTALLED_CASES: AgentEvalCase[] = [
  {
    id: 'ts-installed-fix-bug',
    description: 'Fix a one-line bug in a project with TypeScript installed, without touching its config',
    tags: ['edit', 'bugfix', 'verification', 'tooling-installed'],
    workspace: {
      ...TS_PROJECT,
      'src/math.ts':
        '// Adds two numbers and returns the sum.\nexport function add(a: number, b: number): number {\n  return a - b;\n}\n',
    },
    setupCommands: INSTALL,
    userMessage:
      "There's a bug in src/math.ts — the `add` function subtracts instead of adding. Fix it so it correctly returns a + b.",
    expect: {
      files: {
        contain: [{ path: 'src/math.ts', substrings: ['function add'] }],
        notContain: [{ path: 'src/math.ts', substrings: ['a - b', 'b - a'] }],
        notModified: CONFIG_UNTOUCHED,
      },
    },
  },
  {
    id: 'ts-installed-type-error',
    description: 'Fix a function whose return type is wrong; tsc is installed and reports the error',
    tags: ['edit', 'bugfix', 'verification', 'tooling-installed'],
    workspace: {
      ...TS_PROJECT,
      'src/port.ts':
        '// Parses a port number from user input, e.g. " 8080 ".\n' +
        'export function parsePort(input: string): number {\n' +
        '  return input.trim();\n' +
        '}\n',
    },
    setupCommands: INSTALL,
    userMessage:
      'src/port.ts does not type-check: parsePort must return the port as a number. Fix it, and make sure the project type-checks.',
    expect: {
      files: {
        matchesRegex: [{ path: 'src/port.ts', patterns: [/Number\(|parseInt\(|\+\s*input|Number\.parseInt\(/] }],
        notContain: [{ path: 'src/port.ts', substrings: ['as unknown as number', '@ts-ignore', ': any'] }],
        notModified: CONFIG_UNTOUCHED,
      },
    },
  },
  {
    id: 'ts-installed-rename-caller',
    description: 'Rename a function used from a second file; tsc catches a caller the rename missed',
    tags: ['edit', 'rename', 'multi-file', 'verification', 'tooling-installed'],
    workspace: {
      ...TS_PROJECT,
      'src/format.ts':
        'export function fmtPrice(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n',
      'src/cart.ts':
        "import { fmtPrice } from './format.js';\n\n" +
        'export function cartTotal(items: number[]): string {\n' +
        '  return fmtPrice(items.reduce((sum, c) => sum + c, 0));\n' +
        '}\n',
    },
    setupCommands: INSTALL,
    userMessage: 'Rename `fmtPrice` in src/format.ts to `formatPrice`, and update everything that uses it.',
    expect: {
      files: {
        contain: [
          { path: 'src/format.ts', substrings: ['export function formatPrice'] },
          { path: 'src/cart.ts', substrings: ['formatPrice'] },
        ],
        notContain: [
          { path: 'src/format.ts', substrings: ['fmtPrice'] },
          { path: 'src/cart.ts', substrings: ['fmtPrice'] },
        ],
        notModified: CONFIG_UNTOUCHED,
      },
    },
  },
];
