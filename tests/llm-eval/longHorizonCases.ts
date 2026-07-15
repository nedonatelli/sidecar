import type { LongHorizonCase } from './longHorizonHarness.js';

// ---------------------------------------------------------------------------
// Long-horizon cases — genuine multi-turn conversations.
//
// Each drives the agent through a REAL sequence of user turns (the agent's own
// output threads into the next turn), and each targets a distinct piece of the
// long-horizon machinery that the single-turn smoke suite cannot reach:
//
//   memory-recall        — a fact stated early must still be usable much later.
//   no-cross-file-drift  — sequential edits to different files must not bleed.
//   plan-survives-work   — a multi-step goal must still be tracked after digressions.
//   compaction-survival  — an early instruction must survive a summarization pass.
//
// These are deliberately WITHIN reach of a capable model on a toy workspace: the
// question is not "can the model code" (the smoke suite covers that) but "does
// SideCar's state hold up across a conversation". A failure here is a
// long-horizon-machinery failure, which is the whole subject of this branch and
// currently has zero coverage.
// ---------------------------------------------------------------------------

export const LONG_HORIZON_CASES: LongHorizonCase[] = [
  {
    id: 'lh-memory-recall',
    description: 'A constraint stated on turn 1 must still govern an edit made on turn 4',
    tags: ['long-horizon', 'memory', 'multi-turn'],
    workspace: {
      'src/config.ts': '// App configuration.\nexport const settings = {\n  retries: 3,\n};\n',
    },
    turns: [
      {
        label: 'state the constraint',
        userMessage:
          'Important for everything that follows: in this project, every numeric config value MUST be even. Just acknowledge, do not change anything yet.',
        expect: { files: { notContain: [{ path: 'src/config.ts', substrings: ['retries: 4', 'retries: 2'] }] } },
      },
      {
        label: 'unrelated read',
        userMessage: 'What is the current value of `retries` in src/config.ts?',
        // Assert the ANSWER, not the METHOD. A model that read config.ts on turn 1
        // and remembers `3` here — instead of re-reading — is exhibiting exactly
        // the memory this case rewards; requiring read_file would penalize the
        // right behavior. (This is why sonnet "failed" the first pass.)
        expect: { finalTextContains: ['3'] },
      },
      {
        label: 'unrelated add',
        userMessage: 'Add a second config value `timeout` set to 10 in src/config.ts.',
        expect: { files: { contain: [{ path: 'src/config.ts', substrings: ['timeout'] }] } },
      },
      {
        label: 'apply the turn-1 constraint from memory',
        userMessage:
          'Now change `retries` to the smallest valid value greater than 3 that satisfies the rule I gave you at the start.',
        // The rule was "must be even", so the answer is 4 — only reachable by
        // recalling turn 1. A model that lost the constraint will write 4 anyway
        // by coincidence OR pick 3.x; the discriminator is that it must be even AND > 3.
        expect: { files: { contain: [{ path: 'src/config.ts', substrings: ['retries: 4'] }] } },
      },
    ],
  },

  {
    id: 'lh-no-cross-file-drift',
    description: 'Sequential edits to three different files must not contaminate each other',
    tags: ['long-horizon', 'multi-turn', 'latch'],
    workspace: {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
    },
    turns: [
      {
        label: 'edit A',
        userMessage: 'In src/a.ts, rename the export `a` to `alpha`. Change nothing else.',
        expect: {
          files: {
            contain: [{ path: 'src/a.ts', substrings: ['alpha'] }],
            matchesRegex: [{ path: 'src/b.ts', patterns: [/export const b = 2/] }],
          },
        },
      },
      {
        label: 'edit B — A and C must be untouched',
        userMessage: 'Now in src/b.ts, rename `b` to `beta`. Only touch src/b.ts.',
        expect: {
          files: {
            contain: [{ path: 'src/b.ts', substrings: ['beta'] }],
            // The turn-1 edit must survive, and C must be pristine.
            matchesRegex: [
              { path: 'src/a.ts', patterns: [/alpha/] },
              { path: 'src/c.ts', patterns: [/export const c = 3/] },
            ],
          },
        },
      },
      {
        label: 'edit C — A and B must both survive',
        userMessage: 'Finally rename `c` to `gamma` in src/c.ts, nothing else.',
        expect: {
          files: {
            contain: [{ path: 'src/c.ts', substrings: ['gamma'] }],
            matchesRegex: [
              { path: 'src/a.ts', patterns: [/alpha/] },
              { path: 'src/b.ts', patterns: [/beta/] },
            ],
          },
        },
      },
    ],
  },

  {
    id: 'lh-plan-survives-work',
    description: 'A three-item goal set on turn 1 must still be completeable after digressions',
    tags: ['long-horizon', 'plans', 'multi-turn'],
    workspace: {
      'TODO.md': '# Tasks\n',
      'src/util.ts': 'export function noop() {}\n',
    },
    turns: [
      {
        label: 'set a three-part goal',
        userMessage:
          'We have three things to do, in order: (1) add a `sum(a,b)` function to src/util.ts, (2) add a `mul(a,b)` function to src/util.ts, (3) list both in TODO.md. Start with just step 1.',
        expect: { files: { contain: [{ path: 'src/util.ts', substrings: ['sum'] }] } },
      },
      {
        label: 'digression',
        userMessage: 'Quick aside — what does the existing `noop` function do?',
        // Pure digression: assert nothing. The test is whether the PLAN survives
        // it (turns 3-4 resume "step 2" / "the last step" by reference). Asserting
        // read_file here tests the digression, not the plan, and penalizes a model
        // that answers about a trivial one-liner from context.
        expect: {},
      },
      {
        label: 'resume the plan by reference',
        userMessage: 'Ok, back to the plan. Do step 2.',
        expect: { files: { contain: [{ path: 'src/util.ts', substrings: ['mul'] }] } },
      },
      {
        label: 'finish the plan by reference',
        userMessage: 'Now do the last step.',
        // Step 3 = list BOTH functions in TODO.md. Reachable only by remembering
        // what the three-part plan was, four turns back.
        expect: { files: { contain: [{ path: 'TODO.md', substrings: ['sum', 'mul'] }] } },
      },
    ],
  },

  {
    id: 'lh-compaction-survival',
    description: 'An instruction from turn 1 must survive a forced compaction pass',
    tags: ['long-horizon', 'compression', 'multi-turn'],
    // Force compaction early so it actually fires within a short conversation.
    configOverrides: { agentMaxTokens: 3000 },
    requiresCompression: true,
    workspace: {
      'src/greeter.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
      'notes.md': '# Notes\n',
    },
    turns: [
      {
        label: 'give a durable instruction, then generate bulk context',
        userMessage:
          'Remember this for later: the magic word is "pineapple". Now read src/greeter.ts and describe in detail, line by line, everything it does and every edge case you can think of.',
        // Setup turn: establish the instruction + generate bulk context to force
        // compaction. The outcome — the magic word surviving compaction — is
        // asserted on the final turn, not here.
        expect: {},
      },
      {
        label: 'more bulk to push the window past the compaction threshold',
        userMessage:
          'Now enumerate ten different ways the greet function could be extended, describing each in a full paragraph.',
        expect: {},
      },
      {
        label: 'recall the instruction from before compaction',
        userMessage: 'Write the magic word I gave you at the very start into notes.md.',
        expect: { files: { contain: [{ path: 'notes.md', substrings: ['pineapple'] }] } },
      },
    ],
  },
];
