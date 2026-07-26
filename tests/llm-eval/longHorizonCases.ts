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
    // Force compaction — WITHOUT this the conversation stays under the token
    // threshold and compaction never fires, so the case tests recall but NOT
    // recall-THROUGH-compaction (which is the whole point). Discovered when an
    // off/on validation of the verbatim fix showed compaction=0 on every
    // memory-recall run, making the fix dormant and the comparison meaningless.
    configOverrides: { agentMaxTokens: 3000 },
    // ~9k chars of canned exposition injected AFTER the constraint turn: the
    // next budget check crosses the 70% threshold with the constraint in the
    // to-be-summarized window — real summarization must carry it, which is
    // exactly what the case tests. Model-verbosity-independent.
    midSeedAfterTurn: 0,
    midSeedChars: 9000,
    requiresCompression: true,
    workspace: {
      'src/config.ts': '// App configuration.\nexport const settings = {\n  retries: 3,\n};\n',
    },
    turns: [
      {
        label: 'state the constraint',
        // The rule is APPLICATION-SCOPED by its own text: it governs values the
        // model is asked to write, never existing ones. The first wording
        // ("every numeric config value MUST be even") made eager retroactive
        // fixing a defensible reading — haiku changed retries 3→2 unprompted
        // during an unrelated edit, and the case punished it four turns later
        // via an indirect assertion. A case must not penalize a defensible
        // interpretation; the contract has to have one correct reading.
        userMessage:
          'A rule to remember for any change I ask you to make later: every numeric config value you WRITE must be even. It only applies to values I ask you to change — leave existing values exactly as they are unless I ask. Just acknowledge.',
        expect: { files: { notContain: [{ path: 'src/config.ts', substrings: ['retries: 4', 'retries: 2'] }] } },
      },
      {
        // MANY SMALL turns, not one bulk turn. The summarizer no-ops below 10
        // messages (a sane guard for real sessions), so a few bulky turns force
        // only tool-result TRUNCATION — token counts drop, the old heuristic
        // said "compaction fired", and the summarizer never ran (found live:
        // splices=0 on every run; the durable-instructions arm was dead).
        // Distinct small tasks accumulate the message count PAST the guard so
        // real summarization fires before the recall turn.
        label: 'filler: describe retries',
        userMessage: 'In one paragraph: what does a retries setting do, and what are sensible values?',
        expect: {},
      },
      {
        label: 'filler: add timeout',
        userMessage: 'Add a `timeout` config value set to 10 in src/config.ts.',
        expect: {
          files: {
            contain: [{ path: 'src/config.ts', substrings: ['timeout'] }],
            // retries stays 3 — the rule scopes itself to REQUESTED changes.
            notContain: [{ path: 'src/config.ts', substrings: ['retries: 2', 'retries: 4'] }],
          },
        },
      },
      {
        label: 'filler: describe timeout',
        userMessage: 'In one paragraph: what does the timeout value govern at runtime?',
        expect: {},
      },
      {
        label: 'filler: add logLevel',
        userMessage: 'Add a `logLevel` config value set to 2 in src/config.ts.',
        expect: {
          files: {
            contain: [{ path: 'src/config.ts', substrings: ['logLevel'] }],
            notContain: [{ path: 'src/config.ts', substrings: ['retries: 2', 'retries: 4'] }],
          },
        },
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
        label: 'apply the turn-1 constraint from memory',
        userMessage:
          'Now change `retries` to the smallest value greater than 3 that satisfies the rule I gave you at the start.',
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
    midSeedAfterTurn: 0,
    midSeedChars: 9000,
    requiresCompression: true,
    workspace: {
      'src/greeter.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
      'notes.md': '# Notes\n',
    },
    turns: [
      {
        label: 'give the durable instruction',
        userMessage: 'Remember this for later: the magic word is "pineapple". Just acknowledge.',
        expect: {},
      },
      // Small distinct turns (not bulk): the summarizer no-ops below 10
      // messages, so the window must fill with MESSAGES, not just tokens —
      // see the memory-recall comment.
      {
        label: 'filler: read greeter',
        userMessage: 'Read src/greeter.ts and say in two sentences what it does.',
        expect: {},
      },
      {
        label: 'filler: extension idea',
        userMessage: 'Suggest one way to extend greet(), in a short paragraph.',
        expect: {},
      },
      {
        label: 'filler: edge cases',
        userMessage: 'List three edge cases greet() should handle, one line each.',
        expect: {},
      },
      {
        label: 'filler: naming',
        userMessage: 'Propose a better name for greet() and justify it in a sentence.',
        expect: {},
      },
      {
        label: 'recall the instruction from before compaction',
        userMessage: 'Write the magic word I gave you at the very start into notes.md.',
        expect: { files: { contain: [{ path: 'notes.md', substrings: ['pineapple'] }] } },
      },
    ],
  },

  {
    id: 'lh-calculator-session',
    description:
      'A realistic incremental calculator build across turns — the practical "can you develop with this model" test',
    tags: ['long-horizon', 'coding', 'calculator', 'multi-turn'],
    // The PRACTICAL question, not a synthetic memory-stress test: can the model
    // sustain a real development loop across turns — reading its own prior work,
    // EDITING it (not just appending), and building on it? This is what "can you
    // develop code with SideCar + <model>" actually means. Reconstructed as a
    // multi-turn session from the single-turn build-python-calculator spec
    // (codeQualityCases.ts). No forced compaction — a real session is however long
    // it naturally is. Assertions are on the produced CODE (deterministic, no
    // Python interpreter needed in the sandbox), and each turn asserts the PRIOR
    // turns' work survived — which is the multi-turn part that single-turn evals
    // cannot see.
    workspace: {
      'README.md': '# Calculator\n\nAn empty project — build the calculator here.\n',
    },
    turns: [
      {
        label: 'start with two operations',
        userMessage:
          'Create calculator.py with two fully-implemented functions: add(a, b) and subtract(a, b). No placeholders.',
        expect: {
          files: {
            exist: ['calculator.py'],
            contain: [{ path: 'calculator.py', substrings: ['def add', 'def subtract'] }],
            notContain: [{ path: 'calculator.py', substrings: ['TODO', 'NotImplementedError', 'pass  #'] }],
          },
        },
      },
      {
        // EDIT prior work: add to the existing file, keeping add/subtract.
        label: 'add the other two operations + a guard',
        userMessage:
          'Now add multiply(a, b) and divide(a, b) to calculator.py. divide must raise ValueError on division by zero.',
        expect: {
          files: {
            // All four now present — turn-1 work must survive the edit.
            contain: [{ path: 'calculator.py', substrings: ['def add', 'def subtract', 'def multiply', 'def divide'] }],
            matchesRegex: [{ path: 'calculator.py', patterns: [/raise\s+ValueError/] }],
          },
        },
      },
      {
        label: 'add tests for what was built',
        userMessage:
          'Write test_calculator.py with one test for each of the four operations and one for the divide-by-zero case.',
        expect: {
          files: {
            exist: ['test_calculator.py'],
            contain: [{ path: 'test_calculator.py', substrings: ['def test', 'divide'] }],
            // calculator.py must still have all four — tests referencing them.
            matchesRegex: [{ path: 'calculator.py', patterns: [/def add/, /def divide/] }],
          },
        },
      },
      {
        label: 'wrap it in a CLI on top of the existing functions',
        userMessage:
          'Add a command-line interface to calculator.py that reads an operation and two numbers from the command line (argparse or sys.argv) and prints the result, supporting all four operations, printing a clear error instead of crashing on divide-by-zero.',
        expect: {
          files: {
            matchesRegex: [
              { path: 'calculator.py', patterns: [/if\s+__name__\s*==\s*['"]__main__['"]/, /argparse|sys\.argv/] },
              // The four functions the CLI dispatches to must all still be there.
              { path: 'calculator.py', patterns: [/def add/, /def subtract/, /def multiply/, /def divide/] },
            ],
          },
        },
      },
    ],
  },
  {
    id: 'lh-cross-session-recall',
    description: 'A standing instruction from session 1 must govern an edit requested in session 2',
    tags: ['long-horizon', 'memory', 'cross-session', 'multi-turn'],
    // Session 1 must genuinely compact (that is what triggers the persist
    // hook), then the boundary discards history entirely: session 2 can only
    // know the rule via .sidecar/memory re-injection. Same forcing scheme as
    // memory-recall (budget + mid-seed).
    configOverrides: { agentMaxTokens: 3000, persistInstructionsEnabled: true },
    midSeedAfterTurn: 0,
    midSeedChars: 9000,
    sessionBoundaryAfterTurn: 2,
    requiresCompression: true,
    workspace: {
      'src/config.ts': '// App configuration.\nexport const settings = {\n  retries: 3,\n};\n',
    },
    turns: [
      {
        label: 'session 1: state the standing rule',
        userMessage:
          'A rule to remember for any change I ask you to make later: every numeric config value you WRITE must be even. It only applies to values I ask you to change — leave existing values exactly as they are unless I ask. Just acknowledge.',
        expect: { files: { notContain: [{ path: 'src/config.ts', substrings: ['retries: 4', 'retries: 2'] }] } },
      },
      {
        label: 'session 1: filler work',
        userMessage: 'Add a `timeout` config value set to 10 in src/config.ts.',
        expect: { files: { contain: [{ path: 'src/config.ts', substrings: ['timeout'] }] } },
      },
      {
        label: 'session 1: more filler (compaction fires here)',
        userMessage: 'In one paragraph: what does the timeout value govern at runtime?',
        expect: {},
      },
      // ---- session boundary: history discarded ----
      {
        label: 'session 2: apply the remembered rule',
        userMessage:
          'Set `retries` in src/config.ts to the smallest value greater than 3 that satisfies the rule I gave you in our earlier session.',
        // Only reachable via the remembered-instructions injection: 4.
        expect: { files: { contain: [{ path: 'src/config.ts', substrings: ['retries: 4'] }] } },
      },
    ],
  },
  {
    id: 'lh-cross-session-prohibition',
    description: 'A "never do X, do Y instead" convention from session 1 must govern code written in session 2',
    tags: ['long-horizon', 'memory', 'cross-session', 'multi-turn'],
    // Diversity vs lh-cross-session-recall: prohibition marker ("Never…")
    // instead of "a rule to remember", and the constraint targets code
    // CONTENT the model writes, not a numeric value. Same forcing mechanics.
    configOverrides: { agentMaxTokens: 3000, persistInstructionsEnabled: true },
    midSeedAfterTurn: 0,
    midSeedChars: 9000,
    sessionBoundaryAfterTurn: 2,
    requiresCompression: true,
    workspace: {
      'src/log.ts': "export function log(msg: string): void {\n  process.stdout.write(msg + '\\n');\n}\n",
      'src/app.ts': "import { log } from './log.js';\n\nexport function start(): void {\n  log('started');\n}\n",
    },
    turns: [
      {
        label: 'session 1: state the prohibition',
        userMessage:
          'Never use console.log in any code you write for me in this project — always use the log() helper from src/log.ts instead. Just acknowledge.',
        expect: {},
      },
      {
        label: 'session 1: filler work',
        userMessage: 'Create notes/logging.md with one sentence about why centralized logging helps.',
        expect: { files: { exist: ['notes/logging.md'] } },
      },
      {
        label: 'session 1: more filler (compaction fires here)',
        userMessage: 'In one paragraph: what tradeoffs come with routing all output through one helper?',
        expect: {},
      },
      // ---- session boundary ----
      {
        label: 'session 2: write code the convention must govern',
        userMessage: 'Add a function `greet(name: string)` to src/app.ts that prints a greeting for the given name.',
        expect: {
          files: {
            contain: [{ path: 'src/app.ts', substrings: ['greet', 'log('] }],
            notContain: [{ path: 'src/app.ts', substrings: ['console.log'] }],
          },
        },
      },
    ],
  },

  {
    id: 'lh-cross-session-fact',
    description: 'A "keep in mind" fact from session 1 must be reproducible in session 2',
    tags: ['long-horizon', 'memory', 'cross-session', 'multi-turn'],
    // Diversity: "keep in mind" marker and FACT recall (write the value back)
    // rather than a constraint governing an edit.
    configOverrides: { agentMaxTokens: 3000, persistInstructionsEnabled: true },
    midSeedAfterTurn: 0,
    midSeedChars: 9000,
    sessionBoundaryAfterTurn: 2,
    requiresCompression: true,
    workspace: {
      'README.md': '# Deploy notes\n',
    },
    turns: [
      {
        label: 'session 1: state the fact',
        userMessage: 'Keep in mind: our deploy code is Kestrel-9. You will need it when I ask later. Just acknowledge.',
        expect: {},
      },
      {
        label: 'session 1: filler work',
        userMessage: 'Create notes/deploy.md with one sentence about what a deploy code is for.',
        expect: { files: { exist: ['notes/deploy.md'] } },
      },
      {
        label: 'session 1: more filler (compaction fires here)',
        userMessage: 'In one paragraph: what can go wrong when deploy credentials are shared informally?',
        expect: {},
      },
      // ---- session boundary ----
      {
        label: 'session 2: reproduce the fact',
        userMessage: 'Write the deploy code I gave you in our earlier session into deploy.txt.',
        expect: { files: { contain: [{ path: 'deploy.txt', substrings: ['Kestrel-9'] }] } },
      },
    ],
  },
];
