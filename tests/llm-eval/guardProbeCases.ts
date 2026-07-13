import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Guard-candidate probe cases.
//
// These are SURVEYS, not regressions — deliberately kept out of
// AGENT_CASES so they never pollute the regression pass rate. Each case
// is designed to elicit one of the tool-call pathologies the scanner
// (guardCandidateScan.ts) counts; whether the model completes the task
// is irrelevant, so `expect` is empty and the probe runner never fails
// a case on candidates. Run via `npm run eval:guardprobe`, ideally
// looped across the standard model sweep.
//
// Provocation rationale per case:
//   - No-signal turns are what produced the live example-replay ("hi" →
//     ask_user's auth-flow example verbatim). They also surface
//     placeholder args from models that feel compelled to call a tool.
//   - Indirect file references invite hallucinated tutorial paths
//     ("path/to/config") from models that guess instead of listing.
//   - Foreign-vocabulary phrasing primes names from other agents'
//     catalogs (strReplace, createFile) in the format the alias table's
//     exact match would miss.
// ---------------------------------------------------------------------------

const SMALL_WORKSPACE = {
  'src/greeter.ts':
    '// Says hello to the given name.\n' +
    'export function greet(name: string): string {\n' +
    '  return `Hello, ${name}!`;\n' +
    '}\n',
};

export const GUARD_PROBE_CASES: AgentEvalCase[] = [
  {
    id: 'probe-no-signal-hi',
    description: 'Bare greeting with no task — should get a text reply, surfaces example replay / placeholder calls',
    tags: ['guard-probe'],
    workspace: SMALL_WORKSPACE,
    userMessage: 'hi',
    maxIterations: 3,
    expect: {},
  },
  {
    id: 'probe-no-signal-thanks',
    description: 'Gratitude with no task — same no-signal shape from the other direction',
    tags: ['guard-probe'],
    workspace: SMALL_WORKSPACE,
    userMessage: 'thanks, great work!',
    maxIterations: 3,
    expect: {},
  },
  {
    id: 'probe-indirect-file-ref',
    description: 'Task names a file only conceptually — invites hallucinated/tutorial paths',
    tags: ['guard-probe'],
    workspace: {
      ...SMALL_WORKSPACE,
      'package.json': '{\n  "name": "probe-fixture",\n  "version": "3.1.4"\n}\n',
    },
    userMessage: 'Open the main configuration file of this project and tell me what version is set.',
    maxIterations: 5,
    expect: {},
  },
  {
    id: 'probe-foreign-vocab-edit',
    description: 'Task phrased in a foreign catalog verb (strReplace) — invites foreign-format tool names',
    tags: ['guard-probe'],
    workspace: SMALL_WORKSPACE,
    userMessage: "Use strReplace to change the greeting in src/greeter.ts from 'Hello' to 'Hi'.",
    maxIterations: 5,
    expect: {},
  },
  {
    id: 'probe-foreign-vocab-create',
    description: 'Task phrased as createFile — invites camelCase names and wrapper-shaped args',
    tags: ['guard-probe'],
    workspace: SMALL_WORKSPACE,
    userMessage: "createFile a file named notes.md containing exactly the line 'guard probe'.",
    maxIterations: 5,
    expect: {},
  },
];
