import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Multi-turn latch cases.
//
// Live dogfood observation: local models LATCH onto earlier turns — a new,
// unrelated prompt gets answered with the previous task's pattern (re-editing
// the previous file, replying in the previous turn's mandated format,
// repeating stale facts instead of re-reading). Each case here seeds a prior
// completed exchange via `setupMessages` (plain text, no tool blocks — the
// latch signal is prior CONTENT, and text-only history is safe on every
// backend), then sends a turn the model should treat fresh. Latching = a
// hard failure; run with SIDECAR_EVAL_TRIALS=3 to measure how reliably a
// model resists, since perseveration is strongly sampling-dependent.
//
// The prior turn is always written as ALREADY REFLECTED in the workspace
// fixture (the "edit" the assistant claims to have made is materialized), so
// a model that re-verifies the old work finds it done and has no legitimate
// reason to touch the old file again.
// ---------------------------------------------------------------------------

export const MULTI_TURN_CASES: AgentEvalCase[] = [
  {
    id: 'latch-thanks-after-edit',
    description: 'Gratitude after a completed edit — must not redo or continue the previous task',
    tags: ['multi-turn', 'latch'],
    workspace: {
      'src/greeter.ts':
        '// Welcomes the given name.\n' +
        'export function welcome(name: string): string {\n' +
        '  return `Hello, ${name}!`;\n' +
        '}\n',
    },
    setupMessages: [
      { role: 'user', content: 'In src/greeter.ts, rename the greet function to welcome.' },
      {
        role: 'assistant',
        content:
          'Done — I edited src/greeter.ts and renamed `greet` to `welcome`. The file now exports `welcome(name: string)`.',
      },
    ],
    setupMessagesRequired: true,
    userMessage: 'thanks, great work!',
    maxIterations: 4,
    expect: {
      toolsNotCalled: ['edit_file', 'write_file', 'delete_file'],
      files: { notModified: ['src/greeter.ts'] },
    },
  },
  {
    id: 'latch-topic-switch',
    description: 'Question about file B after a task on file A — must not drift back to file A',
    tags: ['multi-turn', 'latch'],
    workspace: {
      'src/logger.ts':
        '/** Writes a timestamped line to stdout. */\n' +
        'export function log(msg: string): void {\n' +
        '  console.log(`[${new Date().toISOString()}] ${msg}`);\n' +
        '}\n',
      'src/mathUtil.ts':
        'export function clamp(value: number, min: number, max: number): number {\n' +
        '  return Math.min(Math.max(value, min), max);\n' +
        '}\n',
    },
    setupMessages: [
      { role: 'user', content: 'Add a JSDoc comment to the log function in src/logger.ts.' },
      {
        role: 'assistant',
        content: 'Done — src/logger.ts now has a JSDoc comment on `log` describing the timestamped stdout write.',
      },
    ],
    setupMessagesRequired: true,
    userMessage: 'What does the clamp function in src/mathUtil.ts do? Answer in one sentence.',
    maxIterations: 5,
    expect: {
      toolsNotCalled: ['edit_file', 'write_file'],
      files: { notModified: ['src/logger.ts'] },
      finalTextContains: [['clamp', 'limit', 'bound', 'restrict', 'between', 'range']],
    },
    softExpect: {
      // Re-reading the PREVIOUS task's file on an unrelated question is the
      // mild perseveration signal — reported, but not a hard failure.
      toolCallNotMatches: [{ name: 'read_file', inputPartial: { path: 'logger' } }],
    },
  },
  {
    id: 'latch-instruction-bleed',
    description: "Turn-scoped format instruction must not bleed into the next turn's answer",
    tags: ['multi-turn', 'latch'],
    workspace: {
      'src/greeter.ts':
        '// Welcomes the given name.\n' +
        'export function welcome(name: string): string {\n' +
        '  return `Hello, ${name}!`;\n' +
        '}\n',
    },
    setupMessages: [
      { role: 'user', content: 'Output a JSON object {"status":"ok"} and nothing else.' },
      { role: 'assistant', content: '{"status":"ok"}' },
    ],
    setupMessagesRequired: true,
    userMessage: 'Describe in one plain-English sentence what src/greeter.ts exports.',
    maxIterations: 5,
    expect: {
      // Latch = answering the new question in the previous turn's JSON format.
      finalTextNotMatchesRegex: [/^\s*\{/],
      finalTextContains: [['welcome', 'greet', 'export', 'function']],
    },
  },
  {
    id: 'latch-stale-fact',
    description: 'Stale fact from an earlier turn must be re-derived, not repeated from memory',
    tags: ['multi-turn', 'latch'],
    workspace: {
      'config/app.json': '{\n  "name": "latch-fixture",\n  "port": 8080\n}\n',
    },
    setupMessages: [
      { role: 'user', content: 'Which port does this app use?' },
      {
        role: 'assistant',
        content: 'The app config sets port 3000.',
      },
    ],
    setupMessagesRequired: true,
    userMessage:
      'The config has changed since then. Read the app config file again and tell me which port is set now.',
    maxIterations: 5,
    expect: {
      // Latch = repeating the remembered 3000 instead of re-reading.
      toolsCalledAny: ['read_file', 'grep', 'search_files', 'list_directory'],
      finalTextContains: [['8080']],
      finalTextNotContains: ['3000'],
    },
  },
];
