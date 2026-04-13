import type { Expectations, CaseResult } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic scorers for LLM eval cases.
//
// Each check returns a failure string when it doesn't hold, or null
// when it does. Aggregated by `score()` into a CaseResult so the
// report can say exactly which predicate tripped.
// ---------------------------------------------------------------------------

function contains(response: string, needle: string): boolean {
  return response.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Score a model response against a case's expectations. `response` is
 * the raw string the model returned; `durationMs` is recorded for the
 * report so we can watch latency drift alongside quality drift.
 */
export function score(
  id: string,
  description: string,
  response: string,
  expect: Expectations,
  durationMs: number,
): CaseResult {
  const failures: string[] = [];

  if (expect.mustContain) {
    for (const needle of expect.mustContain) {
      if (!contains(response, needle)) failures.push(`mustContain: missing "${needle}"`);
    }
  }
  if (expect.mustNotContain) {
    for (const needle of expect.mustNotContain) {
      if (contains(response, needle)) failures.push(`mustNotContain: present "${needle}"`);
    }
  }
  if (expect.mustMatch) {
    for (const pattern of expect.mustMatch) {
      if (!pattern.test(response)) failures.push(`mustMatch: failed ${pattern}`);
    }
  }
  if (expect.mustNotMatch) {
    for (const pattern of expect.mustNotMatch) {
      if (pattern.test(response)) failures.push(`mustNotMatch: matched ${pattern}`);
    }
  }
  if (expect.minLength !== undefined && response.length < expect.minLength) {
    failures.push(`minLength: ${response.length} < ${expect.minLength}`);
  }
  if (expect.maxLength !== undefined && response.length > expect.maxLength) {
    failures.push(`maxLength: ${response.length} > ${expect.maxLength}`);
  }

  return {
    id,
    description,
    passed: failures.length === 0,
    failures,
    response,
    durationMs,
  };
}

/**
 * Render a compact markdown summary of a batch of case results.
 * Used by the eval runner to produce a human-readable report, but
 * also by the vitest suite for per-case error messages.
 */
export function renderReport(results: CaseResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const lines: string[] = [];
  lines.push(`# LLM Eval Report`);
  lines.push('');
  lines.push(`**Score: ${passed} / ${total} passed**`);
  lines.push('');
  for (const r of results) {
    const mark = r.passed ? '✅' : '❌';
    lines.push(`## ${mark} ${r.id} — ${r.description}`);
    lines.push(`*Duration: ${r.durationMs}ms*`);
    if (r.failures.length > 0) {
      lines.push('');
      lines.push('Failures:');
      for (const f of r.failures) lines.push(`- ${f}`);
    }
    lines.push('');
    lines.push('<details><summary>Response</summary>');
    lines.push('');
    lines.push('```');
    lines.push(r.response.length > 1500 ? r.response.slice(0, 1500) + '\n... (truncated)' : r.response);
    lines.push('```');
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
}
