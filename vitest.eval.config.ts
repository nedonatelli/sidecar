import { defineConfig } from 'vitest/config';

// ---------------------------------------------------------------------------
// LLM evaluation harness — separate from the main unit suite.
//
// The eval suite drives real models (Anthropic / OpenAI / local Ollama)
// against a small dataset of user requests to detect quality
// regressions when we change the system prompt, tool descriptions, or
// compression strategies. It is NOT part of `npm test` because:
//   - It costs money (paid APIs) or takes time (local models)
//   - It requires network / local daemon availability
//   - It is inherently flaky — LLMs are nondeterministic, so individual
//     cases skip-pass rather than hard-fail on borderline outputs
//
// Run explicitly:  `npm run eval:llm`
//
// Cases that require a backend gracefully skip when the relevant env
// var (ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST) is absent, so
// the suite is always green in environments that can't pay the cost.
// ---------------------------------------------------------------------------

// SIDECAR_EVAL_CASE_TIMEOUT drives both the per-case agent abort (in
// agentHarness.ts) and the vitest test timeout (here). The vitest
// timeout is set to case timeout + 60 s to allow for sandbox
// setup/teardown on top of the model response time.
const rawCaseTimeout = parseInt(process.env.SIDECAR_EVAL_CASE_TIMEOUT ?? '', 10);
// Default raised from 120s to 240s: multi-step tool workflows on local 7B+ models
// routinely need 3-4 minutes (run_command → read → edit → re-run). 120s was
// hitting timeout before the agent could complete the edit-verify loop, producing
// spurious failures that looked like the model couldn't tool-call.
const caseTimeout = Number.isFinite(rawCaseTimeout) && rawCaseTimeout > 0 ? rawCaseTimeout : 240_000;

// SIDECAR_EVAL_TRIALS=N runs N trials INSIDE a single `it()`, sequentially. The
// vitest budget therefore has to cover all of them — it did not, so any real
// reliability run (the whole point of trials) was killed mid-way at the
// single-case budget. Observed: a 25-trial run completed 4 of 9 cases and reported
// the rest as timeouts that looked like model failures.
//
// That mattered more than a slow test. Multi-trial evals are the only way to tell
// a regression from variance — a supposedly-boring `grep` case measures 88%
// reliable, and `no-stub-in-write` is a 52% coin flip — so a harness that cannot
// run trials cannot answer whether scaffolding helps.
const trials = Math.max(1, parseInt(process.env.SIDECAR_EVAL_TRIALS ?? '1', 10) || 1);
const vitestTimeout = caseTimeout * trials + 60_000;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/llm-eval/**/*.eval.ts', 'bench/**/*.eval.ts'],
    // Stream console output instead of replaying it when the file finishes.
    // Vitest intercepts console.log by default, so a 10-minute agent case
    // showed NOTHING until it ended — every progress check during a sweep was
    // blind, and a run that had already gone wrong looked identical to one
    // still working. Note this is only half the fix: stdout redirected to a
    // file is not a TTY, so Node still block-buffers. The runners wrap the
    // command in `script -q /dev/null` to get a pty.
    disableConsoleIntercept: true,
    // Eval runs network requests against real LLM backends. Default
    // vitest timeout (5s) is too short for anything but local Ollama.
    // Set via SIDECAR_EVAL_CASE_TIMEOUT (default 120 000 ms) + 60 s overhead.
    testTimeout: vitestTimeout,
    // Run test files sequentially so all files share the same Ollama
    // connection without contention. Parallel file execution causes prompt
    // and agent eval workers to queue requests on the same local model
    // simultaneously — prompt cases exhaust most of the agent case timeout
    // before the model becomes available, producing spurious empty-trajectory
    // failures that look like the model can't tool-call at all.
    fileParallelism: false,
    // Eval cases carry their own logs; don't drown them in vitest's
    // default noisy output.
    reporters: ['verbose'],
    alias: {
      vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
