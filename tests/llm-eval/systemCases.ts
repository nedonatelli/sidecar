import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// System-infrastructure eval cases.
//
// These cases measure how well SideCar's built-in infrastructure
// compensates for known model limitations — each is paired with a
// specific feature that catches or corrects the failure:
//
//   completion gate   — catches models that skip `run_tests` after editing
//   stub validator    — catches models that write TODO/placeholder code
//   adversarial critic — catches models that write insecure code
//   SIDECAR.md        — enforces project conventions the prompt never mentions
//   cycle detection   — breaks infinite edit-retry loops
//
// Pass conditions are always on the FINAL artifact (file content,
// tool trajectory), not on whether the infrastructure event fired.
// A strong model that avoids the failure on its own still passes —
// the cases are designed so that weak models are rescued by the
// infrastructure and strong models are unaffected.
//
// softExpect entries capture evidence of infrastructure firing (e.g.
// run_tests called, trajectoryHasToolError) without gating pass/fail
// on them — a model that follows rule 6 on its own shouldn't fail
// because the gate never needed to intervene.
//
// Authoring notes:
//   - Workspace fixtures use plain .js so the agent can run tests via
//     `node` without a TypeScript build step.
//   - package.json `test` scripts use `node` directly for the same
//     reason — no jest/vitest to install.
//   - Cases with configOverrides (critic) make one extra LLM call
//     internally; keep their workspace fixtures small.
// ---------------------------------------------------------------------------

export const SYSTEM_CASES: AgentEvalCase[] = [
  // -------------------------------------------------------------------------
  // 1. Completion gate — forces test run after edit
  //
  // Known limitation: most models skip `run_tests` after fixing a bug
  // (Operating Rule 6 failure — observed across all tested models).
  // The completion gate blocks the agent from finishing until it calls
  // run_tests or get_diagnostics on the edited file.
  // -------------------------------------------------------------------------
  {
    id: 'gate-run-tests-after-fix',
    description:
      'Completion gate forces run_tests after a bug fix — agent cannot declare done without verifying the edit',
    tags: ['gate', 'run-tests', 'system-infra', 'trajectory'],
    workspace: {
      'package.json': JSON.stringify({ name: 'eval-sandbox', scripts: { test: 'node src/divide.test.js' } }, null, 2),
      'src/divide.js':
        'function divide(a, b) {\n' +
        '  return a + b; // BUG: should be a / b\n' +
        '}\n' +
        'module.exports = { divide };\n',
      // Colocated test so the completion gate's findColocatedTest() detects it
      // and injects a "run tests" requirement rather than just a lint check.
      'src/divide.test.js':
        "const { divide } = require('./divide.js');\n" +
        'const result = divide(10, 2);\n' +
        'if (result !== 5) throw new Error(`Expected 5, got ${result}`);\n' +
        "console.log('ok');\n",
    },
    userMessage: 'The divide function in src/divide.js has a bug. Fix it.',
    maxIterations: 10,
    expect: {
      toolsCalled: ['edit_file', 'run_tests'],
      trajectoryOrder: [{ before: 'edit_file', after: 'run_tests' }],
      files: {
        contain: [{ path: 'src/divide.js', substrings: ['a / b'] }],
        notContain: [{ path: 'src/divide.js', substrings: ['a + b'] }],
      },
    },
    softExpect: {
      finalTextMatchesRegex: [/pass|ok|success|correct/i],
    },
  },

  // -------------------------------------------------------------------------
  // 2. Stub validator — forces complete implementation
  //
  // Known limitation: many models (gemma4, grok-3-mini, llama3.2, granite)
  // leave TODO comments or `throw new Error('not implemented')` stubs when
  // asked to implement multiple functions. The stub validator detects these
  // patterns after write_file/edit_file and reprompts once.
  // -------------------------------------------------------------------------
  {
    id: 'stub-validator-forces-real-impl',
    description:
      'Stub validator detects TODO/placeholder code and reprompts — final file must have complete implementations',
    tags: ['stub-validator', 'system-infra', 'edit'],
    workspace: {
      'src/validators.js':
        "'use strict';\n" +
        '\n' +
        'function isValidEmail(str) {\n' +
        '  // TODO: implement email validation\n' +
        "  throw new Error('not implemented');\n" +
        '}\n' +
        '\n' +
        'function isValidPhone(str) {\n' +
        '  // TODO: implement phone validation\n' +
        "  throw new Error('not implemented');\n" +
        '}\n' +
        '\n' +
        'function isPositiveInteger(n) {\n' +
        '  // TODO: implement\n' +
        "  throw new Error('not implemented');\n" +
        '}\n' +
        '\n' +
        'module.exports = { isValidEmail, isValidPhone, isPositiveInteger };\n',
    },
    userMessage:
      'Implement the three functions in src/validators.js. ' +
      'Remove all TODO comments and placeholder throws — each function must have a real, working implementation.',
    maxIterations: 10,
    expect: {
      toolsCalled: ['edit_file'],
      files: {
        exist: ['src/validators.js'],
        notContain: [
          {
            path: 'src/validators.js',
            substrings: ['// TODO', "throw new Error('not implemented')", '// implement', '// placeholder'],
          },
        ],
        // Each function must have real logic — a return statement that
        // isn't just `return false` or `return null`.
        contain: [
          {
            path: 'src/validators.js',
            substrings: ['isValidEmail', 'isValidPhone', 'isPositiveInteger'],
          },
        ],
        matchesRegex: [
          {
            path: 'src/validators.js',
            // Email: must use a regex or indexOf('@') — something beyond a stub
            patterns: [/@|indexOf|includes|test\s*\(/],
          },
        ],
      },
    },
    softExpect: {
      // Stub validator fires and leaves a trace in text output
      finalTextMatchesRegex: [/implement|valid|email|phone/i],
    },
  },

  // -------------------------------------------------------------------------
  // 3. Adversarial critic — flags insecure code and forces a fix
  //
  // Known limitation: models often write path traversal vulnerabilities
  // when asked to read user-supplied filenames without sanitizing them.
  // The critic fires after edits and blocks the turn on security findings.
  //
  // configOverrides enables the critic (off by default — it makes an
  // extra LLM call). The pass condition is on the final file content,
  // not on whether the critic fired — a model that writes safe code from
  // the start also passes.
  // -------------------------------------------------------------------------
  {
    id: 'critic-security-path-traversal',
    description:
      'Critic-enabled run: agent implements a file-read endpoint — final code must validate filename to prevent path traversal',
    tags: ['critic', 'security', 'system-infra', 'edit'],
    configOverrides: { criticEnabled: true },
    workspace: {
      'src/fileReader.js':
        "const fs = require('fs');\n" +
        "const path = require('path');\n" +
        "const DATA_DIR = path.join(__dirname, '../data');\n" +
        '\n' +
        '/**\n' +
        ' * Reads a file from the data directory by filename.\n' +
        ' * @param {string} filename\n' +
        ' * @returns {string}\n' +
        ' */\n' +
        'function readDataFile(filename) {\n' +
        '  // TODO: implement\n' +
        "  throw new Error('not implemented');\n" +
        '}\n' +
        '\n' +
        'module.exports = { readDataFile };\n',
    },
    userMessage:
      'Implement `readDataFile` in src/fileReader.js. ' +
      'It receives a filename from user input and must return the contents of that file from the data directory. ' +
      'Make sure the implementation is production-safe.',
    maxIterations: 12,
    expect: {
      toolsCalled: ['edit_file'],
      files: {
        exist: ['src/fileReader.js'],
        // Safe implementation must validate the filename — check for
        // path traversal attempts (.. or absolute paths).
        matchesRegex: [
          {
            path: 'src/fileReader.js',
            patterns: [/\.\.|path\.normalize|path\.resolve|basename|indexOf\s*\(\s*['"]\.\./],
          },
        ],
        notContain: [
          {
            path: 'src/fileReader.js',
            substrings: ["throw new Error('not implemented')"],
          },
        ],
      },
    },
    softExpect: {
      // Answer should mention security or validation
      finalTextContains: ['traversal', 'validat', 'sanitiz', 'secur', '..'],
    },
  },

  // -------------------------------------------------------------------------
  // 4. SIDECAR.md scoped instruction enforcement
  //
  // Known limitation: models don't know project conventions unless told.
  // SIDECAR.md injects project-specific rules into the system prompt.
  // This case checks that the agent follows a convention stated only in
  // SIDECAR.md — never repeated in the user message.
  //
  // The SIDECAR.md section uses @paths scoping so it only applies to
  // src/**/*.js files. The harness already handles SIDECAR.md injection
  // when it appears in the workspace fixture.
  // -------------------------------------------------------------------------
  {
    id: 'sidecar-md-enforces-convention',
    description:
      'SIDECAR.md project rule (JSDoc @throws required on throwing functions) is followed without the user mentioning it',
    tags: ['sidecar-md', 'system-infra', 'edit'],
    workspace: {
      'SIDECAR.md':
        '## Code Style\n\n' +
        '<!-- @paths: src/**/*.js -->\n\n' +
        'All functions that can throw errors must include a `@throws` JSDoc comment ' +
        'describing what errors may be thrown and under what conditions.\n',
      'src/config.js': "'use strict';\n" + '\n' + 'module.exports = {};\n',
    },
    userMessage:
      'Add a `parseConfig` function to src/config.js. ' +
      'It takes a JSON string, parses it, and returns the resulting object. ' +
      'It should throw a descriptive error if the input is not valid JSON.',
    maxIterations: 8,
    expect: {
      toolsCalled: ['edit_file'],
      files: {
        exist: ['src/config.js'],
        // SIDECAR.md requires @throws for throwing functions
        contain: [{ path: 'src/config.js', substrings: ['@throws', 'parseConfig'] }],
        // Must have a real JSON.parse call
        matchesRegex: [{ path: 'src/config.js', patterns: [/JSON\.parse/] }],
      },
    },
    softExpect: {
      // The function should handle the error case
      files: {
        matchesRegex: [{ path: 'src/config.js', patterns: [/try|catch|SyntaxError/] }],
      },
    },
  },

  // -------------------------------------------------------------------------
  // 5. Cycle detection — breaks infinite edit-retry loop
  //
  // Known limitation: smaller models (llama3.2, granite) keep retrying
  // the same failing edit_file call when the search string doesn't match
  // the actual file content — a common real-world scenario when the
  // model's training knowledge differs from the actual codebase.
  //
  // The workspace has `x * 3` but the user message says "currently
  // returns x + x". The model will try to find `x + x`, fail, and may
  // loop. Cycle detection should break the loop and the model should
  // pivot to reading the file first.
  // -------------------------------------------------------------------------
  {
    id: 'cycle-detection-edit-pivot',
    description:
      'Cycle detection breaks a model stuck retrying a non-matching edit_file — model must read the file and fix the actual content',
    tags: ['cycle-detection', 'system-infra', 'edit', 'error-recovery'],
    workspace: {
      'src/utils.js':
        'function double(x) {\n' +
        '  return x * 3; // wrong: should be x * 2\n' +
        '}\n' +
        'module.exports = { double };\n',
    },
    // Deliberately misdescribe the current implementation to trigger
    // edit_file failures — the model expects `x + x` but finds `x * 3`.
    userMessage:
      'The `double` function in src/utils.js currently returns `x + x` but it should return `x * 2`. Fix it.',
    maxIterations: 12,
    expect: {
      // Must eventually call read_file to discover the real content
      toolsCalled: ['edit_file'],
      // read_file must come before the final successful edit
      files: {
        contain: [{ path: 'src/utils.js', substrings: ['x * 2'] }],
        notContain: [{ path: 'src/utils.js', substrings: ['x * 3'] }],
      },
    },
    softExpect: {
      // At least one edit_file call should have failed before the pivot
      trajectoryHasToolError: true,
    },
  },
];
