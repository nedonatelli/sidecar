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
      // `run_tests` is the subject — the completion gate must force it. Which
      // tracked write tool made the fix is incidental, so it is asserted as
      // either, on both the call and the ordering.
      toolsCalled: ['run_tests'],
      toolsCalledAny: ['edit_file', 'write_file'],
      trajectoryOrder: [{ before: ['edit_file', 'write_file'], after: 'run_tests' }],
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
      // No tool pin. The requirement is that the three functions end up as real
      // implementations with no TODOs — `files` below asserts exactly that.
      // claude-sonnet-5 achieved it with write_file and was failed for not using
      // edit_file, which verified nothing the file contents do not.
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
      // Either tracked write tool. The file-outcome assertions below decide
      // correctness; which write route reached it is not what this case
      // measures, and whole-file rewrite is a supported strategy.
      toolsCalledAny: ['edit_file', 'write_file'],
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
      // `edit_file` stays pinned here, unlike the other bug-fix cases. The
      // fixture deliberately misdescribes the file so that edit_file's search
      // cannot match, and the subject IS the cycle detector breaking that
      // retry loop. A whole-file rewrite sidesteps the trap entirely, so the
      // case would pass while measuring none of the mechanism it exists for.
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
