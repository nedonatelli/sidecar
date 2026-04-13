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

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/llm-eval/**/*.eval.ts'],
    // Eval runs network requests against real LLM backends. Default
    // vitest timeout (5s) is too short for anything but local Ollama.
    testTimeout: 60_000,
    // Eval cases carry their own logs; don't drown them in vitest's
    // default noisy output.
    reporters: ['verbose'],
    alias: {
      vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
