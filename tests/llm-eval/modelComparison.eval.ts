import { describe, it } from 'vitest';
import { AGENT_CASES } from './agentCases.js';
import { CODE_QUALITY_CASES } from './codeQualityCases.js';
import { runAgentCase, AGENT_BACKENDS } from './agentHarness.js';
import type { AgentEvalBackend } from './agentHarness.js';
import type { AgentCaseResult, AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Multi-model comparison runner.
//
// Runs every agent-loop eval case against N models in parallel describe
// blocks, then renders a side-by-side pass/fail table so you can compare
// quality across backends or model sizes without running eval:llm N times
// and manually diffing output.
//
// Usage:
//   SIDECAR_EVAL_COMPARE_MODELS="ollama:qwen3-coder:30b,anthropic:claude-haiku-4-5-20251001" \
//     npm run eval:compare
//
// Format: comma-separated `<backend>:<model>` entries. The backend prefix
// must be one of: ollama, anthropic, openai. The model name may itself
// contain colons (e.g. "qwen3-coder:30b") — only the *first* colon is
// treated as the backend separator.
//
// Individual case tests throw only on infra errors (backend unreachable,
// sandbox setup failed). Case regressions are NOT thrown — that would stop
// the matrix mid-run and leave the comparison table incomplete. Instead,
// pass/fail is accumulated and the final comparison report throws when any
// model had regressions, printing the full cross-model table first.
// ---------------------------------------------------------------------------

const ALL_CASES: AgentEvalCase[] = [...AGENT_CASES, ...CODE_QUALITY_CASES];

interface ModelSpec {
  label: string;
  backend: AgentEvalBackend;
  model: string;
}

function parseCompareModels(): ModelSpec[] | null {
  const raw = process.env.SIDECAR_EVAL_COMPARE_MODELS;
  if (!raw?.trim()) return null;
  const specs: ModelSpec[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      console.warn(`[eval:compare] Skipping malformed entry (no backend prefix): "${trimmed}"`);
      continue;
    }
    const backendName = trimmed.slice(0, colon);
    const model = trimmed.slice(colon + 1);
    const backend = AGENT_BACKENDS[backendName];
    if (!backend) {
      console.warn(`[eval:compare] Unknown backend "${backendName}" in entry "${trimmed}" — valid: ollama, anthropic, openai`);
      continue;
    }
    specs.push({ label: trimmed, backend, model });
  }
  return specs.length > 0 ? specs : null;
}

const models = parseCompareModels();

// results[caseId][modelLabel] = AgentCaseResult or an Error (infra failure surfaced here too)
type RunOutcome = AgentCaseResult | { infra: true; message: string };
const matrix = new Map<string, Map<string, RunOutcome>>();
for (const c of ALL_CASES) matrix.set(c.id, new Map());

describe.skipIf(!models)('llm-eval :: model comparison', () => {
  for (const spec of models ?? []) {
    describe(`model: ${spec.label}`, () => {
      for (const evalCase of ALL_CASES) {
        it(evalCase.id, async () => {
          let result: AgentCaseResult;
          try {
            result = await runAgentCase(evalCase, spec.backend, 120_000, spec.model);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            matrix.get(evalCase.id)!.set(spec.label, { infra: true, message: msg });
            // Re-throw infra failures — backend down is a hard stop, not a model quality signal.
            throw new Error(`[infra] ${spec.label} / ${evalCase.id}: ${msg}`);
          }
          // Store result regardless of pass/fail — we need the full matrix before rendering.
          matrix.get(evalCase.id)!.set(spec.label, result);
          // Do NOT throw on case regression here; the comparison report handles that.
        });
      }
    });
  }

  it('comparison report', () => {
    const report = renderComparisonReport(matrix, models ?? [], ALL_CASES);
    // eslint-disable-next-line no-console -- intentional report output
    console.log('\n\n' + report);

    // Fail the suite if any model had regressions so CI flags this run.
    const regressions: string[] = [];
    for (const spec of models ?? []) {
      const failed = ALL_CASES.filter((c) => {
        const outcome = matrix.get(c.id)?.get(spec.label);
        return outcome && !('infra' in outcome) && !outcome.passed;
      });
      if (failed.length > 0) {
        regressions.push(`${spec.label}: ${failed.length} regression(s) — ${failed.map((c) => c.id).join(', ')}`);
      }
    }
    if (regressions.length > 0) {
      throw new Error('Model comparison regressions:\n' + regressions.map((r) => `  • ${r}`).join('\n'));
    }
  });
});

describe.skipIf(!!models)('llm-eval :: model comparison — not configured', () => {
  it('skipped — set SIDECAR_EVAL_COMPARE_MODELS=backend:model,backend:model to run', () => {
    // Intentionally empty. Provides a clear message rather than silently passing.
  });
});

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderComparisonReport(
  matrix: Map<string, Map<string, RunOutcome>>,
  specs: ModelSpec[],
  cases: AgentEvalCase[],
): string {
  const lines: string[] = [];

  lines.push('# LLM Eval — Model Comparison');
  lines.push('');

  if (specs.length === 0 || cases.length === 0) {
    lines.push('*(no data)*');
    return lines.join('\n');
  }

  // Column headers: case ID + one column per model
  const caseColW = Math.max(4, ...cases.map((c) => c.id.length));
  const modelColW = specs.map((s) => Math.max(s.label.length, 12));

  const hr = (char = '─') => {
    const parts = [char.repeat(caseColW + 2)];
    for (const w of modelColW) parts.push(char.repeat(w + 2));
    return '┼' + parts.join('┼') + '┼';
  };

  const row = (cells: string[]) => {
    const parts = [pad(cells[0], caseColW)];
    for (let i = 0; i < specs.length; i++) {
      parts.push(pad(cells[i + 1] ?? '', modelColW[i]));
    }
    return '│ ' + parts.join(' │ ') + ' │';
  };

  // Header
  const topBorder = '┌' + ['─'.repeat(caseColW + 2), ...modelColW.map((w) => '─'.repeat(w + 2))].join('┬') + '┐';
  const botBorder = '└' + ['─'.repeat(caseColW + 2), ...modelColW.map((w) => '─'.repeat(w + 2))].join('┴') + '┘';
  const sepRow = '├' + hr() + '┤';

  lines.push(topBorder);
  lines.push(row(['Case', ...specs.map((s) => s.label)]));
  lines.push(sepRow);

  // Per-case rows
  for (const c of cases) {
    const cells = specs.map((s) => {
      const outcome = matrix.get(c.id)?.get(s.label);
      if (!outcome) return '⋯';
      if ('infra' in outcome) return '💥 infra';
      return outcome.passed ? `✅ ${fmtMs(outcome.durationMs)}` : `❌ ${fmtMs(outcome.durationMs)}`;
    });
    lines.push(row([c.id, ...cells]));
  }

  lines.push(sepRow);

  // Totals row
  const totals = specs.map((s) => {
    let pass = 0;
    let total = 0;
    for (const c of cases) {
      const outcome = matrix.get(c.id)?.get(s.label);
      if (!outcome || 'infra' in outcome) continue;
      total++;
      if (outcome.passed) pass++;
    }
    const pct = total > 0 ? Math.round((pass / total) * 100) : 0;
    return `${pass}/${total} (${pct}%)`;
  });
  lines.push(row(['PASS RATE', ...totals]));
  lines.push(botBorder);

  // Per-tag breakdown
  const allTags = [...new Set(cases.flatMap((c) => c.tags))].sort();
  if (allTags.length > 0) {
    lines.push('');
    lines.push('## Pass rate by tag');
    lines.push('');
    const tagColW = Math.max(3, ...allTags.map((t) => t.length));
    const tagModelColW = specs.map((s) => Math.max(s.label.length, 10));

    const tagTopBorder = '┌' + ['─'.repeat(tagColW + 2), ...tagModelColW.map((w) => '─'.repeat(w + 2))].join('┬') + '┐';
    const tagBotBorder = '└' + ['─'.repeat(tagColW + 2), ...tagModelColW.map((w) => '─'.repeat(w + 2))].join('┴') + '┘';
    const tagSepRow =
      '├' +
      ['─'.repeat(tagColW + 2), ...tagModelColW.map((w) => '─'.repeat(w + 2))].join('┼') +
      '┤';
    const tagRow = (cells: string[]) => {
      const parts = [pad(cells[0], tagColW)];
      for (let i = 0; i < specs.length; i++) parts.push(pad(cells[i + 1] ?? '', tagModelColW[i]));
      return '│ ' + parts.join(' │ ') + ' │';
    };

    lines.push(tagTopBorder);
    lines.push(tagRow(['Tag', ...specs.map((s) => s.label)]));
    lines.push(tagSepRow);

    for (const tag of allTags) {
      const tagCases = cases.filter((c) => c.tags.includes(tag));
      const tagTotals = specs.map((s) => {
        let pass = 0;
        let total = 0;
        for (const c of tagCases) {
          const outcome = matrix.get(c.id)?.get(s.label);
          if (!outcome || 'infra' in outcome) continue;
          total++;
          if (outcome.passed) pass++;
        }
        const pct = total > 0 ? Math.round((pass / total) * 100) : 0;
        return `${pass}/${total} (${pct}%)`;
      });
      lines.push(tagRow([tag, ...tagTotals]));
    }
    lines.push(tagBotBorder);
  }

  return lines.join('\n');
}

function pad(s: string, width: number): string {
  // Strip ANSI codes for width calculation (emoji etc. are 2-wide but we accept slight misalignment)
  const visible = s.replace(/\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, width - visible.length));
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
