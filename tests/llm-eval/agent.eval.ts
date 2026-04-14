import { describe, it } from 'vitest';
import { AGENT_CASES } from './agentCases.js';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { renderAgentReport } from './agentScorers.js';
import type { AgentCaseResult } from './agentTypes.js';

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

  for (const evalCase of AGENT_CASES) {
    it(`${evalCase.id} — ${evalCase.description}`, async () => {
      const b = backend!;
      let result: AgentCaseResult;
      try {
        result = await runAgentCase(evalCase, b);
      } catch (err) {
        // Infra errors (daemon down, network blip, timeout) surface
        // here. Re-throw with a marker so the report clearly
        // distinguishes infra breakage from case regressions.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Agent case "${evalCase.id}" infra-failed: ${msg}`);
      }

      allResults.push(result);

      if (!result.passed) {
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
        throw new Error(lines.join('\n'));
      }
    });
  }

  it('summary', () => {
    // eslint-disable-next-line no-console -- intentional report output
    console.log('\n\n' + renderAgentReport(allResults));
  });
});

describe.skipIf(backend)('llm-eval :: agent loop — no backend available', () => {
  it('skipped — set SIDECAR_EVAL_BACKEND or run a local Ollama daemon', () => {
    // Intentionally empty. The skipIf inversion gives users a single
    // clear message instead of a long list of skips. Default backend
    // is Ollama, so this only fires when SIDECAR_EVAL_BACKEND is set
    // explicitly to anthropic/openai and the corresponding API key is
    // absent.
  });
});
