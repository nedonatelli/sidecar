import { describe, it } from 'vitest';
import { buildBaseSystemPrompt } from '../../src/webview/handlers/systemPrompt.js';
import { CASES } from './cases.js';
import { score, renderReport } from './scorers.js';
import { pickBackend, pickModel } from './backend.js';
import type { CaseResult } from './types.js';
import { appendFailure, writeHeader, writeSummary } from './evalReporter.js';

// ---------------------------------------------------------------------------
// LLM eval suite — runs the case dataset against a real model backend.
//
// Each case becomes its own `it` so vitest's per-test output shows
// which cases pass and which regressed, with the scorer's failure
// list embedded in the assertion message. The whole suite is skipped
// cleanly when no API key is configured so contributors without
// credentials get a green run instead of a red one.
//
// Run with: `npm run eval:llm`
// ---------------------------------------------------------------------------

const backend = pickBackend();

// When SIDECAR_EVAL_CASE is set, only register it() blocks for matching cases.
// Accepts comma-separated IDs or substrings: SIDECAR_EVAL_CASE=rule3,plan-mode
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());

// When SIDECAR_EVAL_TAGS is set, only run cases that have ALL specified tags.
// Mirrors agent.eval.ts: SIDECAR_EVAL_TAGS=smoke skips this whole suite since
// no prompt cases carry the 'smoke' tag.
const TAG_FILTER = process.env.SIDECAR_EVAL_TAGS?.split(',').map((s) => s.trim());

// Stable fixture — keeps the expected-version regex in the identity
// case byte-identical across runs. Everything project-specific
// (baseUrl, model, etc.) comes from env vars at real run time; this
// is only for the prompt-build step.
const SYSTEM_PROMPT_PARAMS = {
  isLocal: false,
  extensionVersion: '1.0.0',
  repoUrl: 'https://github.com/nedonatelli/sidecar',
  docsUrl: 'https://nedonatelli.github.io/sidecar/',
  root: '/eval/fixture',
  approvalMode: 'cautious' as const,
};

describe.skipIf(!backend)(`llm-eval :: base system prompt [${backend?.name ?? 'unknown'}]`, () => {
  const allResults: CaseResult[] = [];
  writeHeader(`llm-eval :: base system prompt [${backend?.name ?? 'unknown'}]`);

  for (const testCase of CASES) {
    if (CASE_FILTER && !CASE_FILTER.some((f) => testCase.id.includes(f))) continue;
    if (TAG_FILTER && !TAG_FILTER.every((t) => testCase.tags.includes(t))) continue;
    it(`${testCase.id} — ${testCase.description}`, async () => {
      // Resolved lazily inside the test so the suite setup can't
      // dereference `backend` before `skipIf` has a chance to run.
      const b = backend!;
      const model = pickModel(b);

      const systemPrompt = buildBaseSystemPrompt({
        ...SYSTEM_PROMPT_PARAMS,
        approvalMode: testCase.approvalMode ?? SYSTEM_PROMPT_PARAMS.approvalMode,
      });

      const start = Date.now();
      let response: string;
      try {
        response = await b.complete({
          systemPrompt,
          userMessage: testCase.userMessage,
          model,
          maxTokens: 1024,
          temperature: 0.2,
        });
      } catch (err) {
        // Model call failures are not eval regressions — they're infra.
        // Surface them as a skip-style message so the suite runner can
        // still aggregate the passing cases.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Backend call failed (not a prompt regression): ${msg}`);
      }
      const durationMs = Date.now() - start;

      const result = score(testCase.id, testCase.description, response, testCase.expect, durationMs);
      allResults.push(result);

      if (!result.passed) {
        const lines = [`Case "${testCase.id}" regressed:`];
        for (const f of result.failures) lines.push(`  - ${f}`);
        lines.push('');
        lines.push('--- response ---');
        lines.push(response.length > 1500 ? response.slice(0, 1500) + '\n... (truncated)' : response);
        lines.push('--- end response ---');
        const msg = lines.join('\n');
        appendFailure(`base system prompt [${backend?.name ?? 'unknown'}]`, testCase.id, msg);
        throw new Error(msg);
      }
    });
  }

  // After the case loop, print a markdown summary. This runs
  // regardless of pass/fail so the user has a full report even when
  // some cases regressed.
  it('summary', () => {
    const passed = allResults.filter((r) => r.passed).length;
    writeSummary(passed, allResults.length);
    // eslint-disable-next-line no-console -- intentional report output
    console.log('\n\n' + renderReport(allResults));
  });
});

describe.skipIf(backend)('llm-eval :: no backend available', () => {
  it(
    'skipped — set ANTHROPIC_API_KEY (Anthropic) or SIDECAR_EVAL_BACKEND=ollama (Ollama) to run the LLM eval suite',
    () => {
      // Intentionally empty. This `describe.skipIf` block runs only
      // when NO backend is available, giving the user a single clear
      // message instead of a long list of skips.
    },
  );
});
