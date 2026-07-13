import { describe, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { AGENT_CASES } from './agentCases.js';
import { CODE_QUALITY_CASES } from './codeQualityCases.js';
import { GIT_CASES } from './gitCases.js';
import { THINKING_CASES } from './thinkingCases.js';
import { SYSTEM_CASES } from './systemCases.js';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { renderAgentReport } from './agentScorers.js';
import { renderReliabilityReport, type ReliabilityRow } from './reliabilityMetrics.js';
import type { AgentCaseResult } from './agentTypes.js';
import { HistoryDb } from '../../src/agent/history/historyDb.js';
import { appendFailure, writeHeader, writeSummary } from './evalReporter.js';

// Write results to .sidecar/history.db when the workspace has one.
// Silently skips when the path can't be resolved (CI without a workspace).
function tryWriteResult(result: AgentCaseResult, model: string, tags: string[]): void {
  try {
    const dbPath = path.join(process.cwd(), '.sidecar', 'history.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new HistoryDb(dbPath);
    db.insertEvalRun({
      timestamp: Date.now(),
      model,
      caseId: result.id,
      passed: result.passed,
      durationMs: result.durationMs,
      iterationsUsed: result.iterationsUsed,
      failures: result.failures,
      tags,
    });
    db.close();
  } catch {
    // Non-fatal — eval results are the primary output; DB write is bonus.
  }
}

const ALL_CASES = [...AGENT_CASES, ...CODE_QUALITY_CASES, ...GIT_CASES, ...THINKING_CASES, ...SYSTEM_CASES];

// When SIDECAR_EVAL_CASE is set, only register it() blocks for matching cases
// so a single targeted run completes in seconds instead of the full suite.
// Accepts comma-separated IDs or substrings: SIDECAR_EVAL_CASE=error-recovery,grep-regex
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());

// When SIDECAR_EVAL_TAGS is set, only run cases that have ALL specified tags.
// Accepts comma-separated tags: SIDECAR_EVAL_TAGS=smoke  or  SIDECAR_EVAL_TAGS=regression,edit
// Use `npm run eval:smoke` for the curated 8-case fast path (~10 min vs ~2 hr full suite).
const TAG_FILTER = process.env.SIDECAR_EVAL_TAGS?.split(',').map((s) => s.trim());

// SIDECAR_EVAL_TRIALS=N runs each case N times and reports reliability
// (pass@1 / flakiness / PASS-FLAKY-FAIL) alongside pass rate. With trials
// enabled, a case only FAILS the vitest run when every trial fails — a
// mixed result is reported as flaky, not a regression, because for local
// models "solvable but unreliable" and "broken" need different responses.
// Default 1 preserves the classic single-shot semantics exactly.
const TRIALS = Math.max(1, parseInt(process.env.SIDECAR_EVAL_TRIALS ?? '1', 10) || 1);

// ---------------------------------------------------------------------------
// Agent-loop eval runner.
//
// Companion to prompt.eval.ts. Where the prompt layer tests "does the
// model respect the system prompt", this layer tests "does the agent
// loop do the right thing when real tools are available": which tools
// does it pick, does it pass sensible arguments, does the post-run
// workspace look right.
//
// Skipped cleanly when no backend is available:
//
//   - Default backend is local Ollama. SideCarClient catches the
//     connection error if the daemon isn't running and the harness
//     re-throws it as an infra error, which vitest treats as a hard
//     failure. Contributors without Ollama should set
//     SIDECAR_EVAL_BACKEND=anthropic (with ANTHROPIC_API_KEY) or
//     =openai (with OPENAI_API_KEY) OR skip this file entirely by
//     running the prompt-only subset manually.
//
//   - For CI that can't reach any backend at all, the suite-level
//     skipIf drops to "no backend" mode which emits a single clear
//     "skipped" message instead of a wall of red.
//
// Why local Ollama by default: agent-loop cases burn real tokens on
// paid APIs — 3 cases × ~3 tool calls × a few K tokens each adds up
// fast. The whole point of having the eval is to run it often; making
// it free makes that possible.
//
// Run with: `npm run eval:llm` (uses vitest.eval.config.ts which
// includes everything under tests/llm-eval/**/*.eval.ts).
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();

describe.skipIf(!backend)('llm-eval :: agent loop', () => {
  const allResults: AgentCaseResult[] = [];
  const reliabilityRows: ReliabilityRow[] = [];
  writeHeader('llm-eval :: agent loop');

  // Circuit breaker: if this many consecutive cases produce zero model output
  // (empty trajectory + near-timeout duration), the API is likely unavailable.
  // Skip remaining cases rather than burning 120 s × N on a dead endpoint.
  let consecutiveApiUnavailable = 0;
  const CIRCUIT_BREAKER_THRESHOLD = 3;

  for (const evalCase of ALL_CASES) {
    if (CASE_FILTER && !CASE_FILTER.some((f) => evalCase.id.includes(f))) continue;
    if (TAG_FILTER && !TAG_FILTER.every((t) => evalCase.tags.includes(t))) continue;
    it(`${evalCase.id} — ${evalCase.description}`, async () => {
      const b = backend!;
      const trialResults: AgentCaseResult[] = [];

      for (let trial = 0; trial < TRIALS; trial++) {
        // Circuit breaker check — fire before spending another timeout budget.
        if (consecutiveApiUnavailable >= CIRCUIT_BREAKER_THRESHOLD) {
          const synthetic: AgentCaseResult = {
            id: evalCase.id,
            description: evalCase.description,
            passed: false,
            apiUnavailable: true,
            failures: [],
            softFailures: [],
            trajectory: [],
            finalText: '',
            workspaceAfter: {},
            durationMs: 0,
            iterationsUsed: 0,
          };
          allResults.push(synthetic);
          consecutiveApiUnavailable++;
          throw new Error(
            `[circuit-breaker] API appears unavailable — ${consecutiveApiUnavailable} consecutive cases produced zero model output. ` +
              `Check rate limits or network connectivity and re-run. ` +
              `Set SIDECAR_EVAL_CASE_TIMEOUT to a higher value if the model is slow to respond.`,
          );
        }

        let trialResult: AgentCaseResult;
        try {
          trialResult = await runAgentCase(evalCase, b);
        } catch (err) {
          // Infra errors (daemon down, network blip, timeout) surface
          // here. Re-throw with a marker so the report clearly
          // distinguishes infra breakage from case regressions.
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Agent case "${evalCase.id}" infra-failed: ${msg}`);
        }

        allResults.push(trialResult);
        trialResults.push(trialResult);
        tryWriteResult(trialResult, b.defaultModel(), evalCase.tags);

        // Update the circuit-breaker counter before checking pass/fail so
        // that api-unavailable cases don't pollute the failure output.
        if (trialResult.apiUnavailable) {
          consecutiveApiUnavailable++;
        } else {
          consecutiveApiUnavailable = 0;
        }
      }

      // Reliability verdict over the scored (non-api-unavailable) trials.
      // Multi-trial semantics: FAIL only when every scored trial failed —
      // a mixed result is FLAKY, reported but not a vitest failure, since
      // "solvable but unreliable" needs investigation, not a red build.
      const scoredTrials = trialResults.filter((r) => !r.apiUnavailable);
      const passes = scoredTrials.filter((r) => r.passed).length;
      if (TRIALS > 1 && scoredTrials.length > 0) {
        reliabilityRows.push({ caseId: evalCase.id, trials: scoredTrials.length, passes });
        if (passes > 0 && passes < scoredTrials.length) {
          // eslint-disable-next-line no-console -- eval diagnostics
          console.log(`[flaky] ${evalCase.id}: ${passes}/${scoredTrials.length} trials passed`);
        }
      }

      const result = scoredTrials.find((r) => !r.passed) ?? trialResults[trialResults.length - 1];
      const caseFailed = TRIALS > 1 ? scoredTrials.length > 0 && passes === 0 : !result.passed;

      if (caseFailed || (scoredTrials.length === 0 && trialResults.length > 0)) {
        if (result.apiUnavailable) {
          // Surface as a distinct infra signal, not a model regression.
          throw new Error(
            `Agent case "${evalCase.id}" api-unavailable: ` +
              `the model produced no output within the case timeout. ` +
              `This is an API availability problem, not a behavioral regression. ` +
              `Re-run when the API is healthy, or increase SIDECAR_EVAL_CASE_TIMEOUT.`,
          );
        }
        const lines = [`Agent case "${evalCase.id}" regressed:`];
        for (const f of result.failures) lines.push(`  - ${f}`);
        lines.push('');
        lines.push('--- trajectory (last 20 events) ---');
        for (const ev of result.trajectory.slice(-20)) {
          if (ev.type === 'tool_call') {
            lines.push(`→ ${ev.name}(${JSON.stringify(ev.input).slice(0, 120)})`);
          } else if (ev.type === 'tool_result') {
            const preview = ev.result.length > 100 ? ev.result.slice(0, 100) + '...' : ev.result;
            lines.push(`← ${ev.name}${ev.isError ? ' [ERROR]' : ''}: ${preview.replace(/\n/g, ' ')}`);
          } else if (ev.type === 'text' && ev.text.trim()) {
            const preview = ev.text.length > 100 ? ev.text.slice(0, 100) + '...' : ev.text;
            lines.push(`TEXT: ${preview.replace(/\n/g, ' ')}`);
          }
        }
        lines.push('');
        lines.push('--- workspace after ---');
        for (const [p, content] of Object.entries(result.workspaceAfter)) {
          const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
          lines.push(`${p}: ${preview.replace(/\n/g, ' ')}`);
        }
        const msg = lines.join('\n');
        appendFailure('agent loop', evalCase.id, msg);
        throw new Error(msg);
      }
    });
  }

  it('summary', () => {
    const passed = allResults.filter((r) => r.passed).length;
    writeSummary(passed, allResults.length);
    // eslint-disable-next-line no-console -- intentional report output
    console.log('\n\n' + renderAgentReport(allResults));
    if (reliabilityRows.length > 0) {
      // eslint-disable-next-line no-console -- intentional report output
      console.log('\n\n' + renderReliabilityReport(reliabilityRows));
    }
  });
});

if (!backend) {
  // No backend available — log once so CI output is clear, then exit.
  // This replaces the old describe.skipIf block whose "no backend available"
  // title was consistently misread by models as a test failure.
  console.warn(
    '\n[eval:smoke] No backend available — set SIDECAR_EVAL_BACKEND (anthropic/openai/groq) ' +
      'and the corresponding API key, or start a local Ollama daemon, then re-run.\n',
  );
}
