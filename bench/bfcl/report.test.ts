import { describe, it, expect } from 'vitest';
import { formatReport, type RunEnvelope } from './report.js';
import type { BfclReport } from './types.js';

const report: BfclReport = { categories: [], macroAccuracy: 1, microAccuracy: 1, passed: 0, total: 0, failures: [] };
const env: RunEnvelope = {
  model: 'm',
  quantization: 'Q4_K_M',
  backend: 'ollama',
  contextTokens: 32_768,
  dataset: 'bundled-fixtures',
  caseCount: 0,
  temperature: 0,
  perCaseTimeoutMs: 1000,
};

describe('formatReport envelope', () => {
  it('states the context window the runner set', () => {
    expect(formatReport(report, env)).toContain('- context: 32768 tokens · temperature: 0');
  });

  it('does not claim a context window it could not set', () => {
    // An OpenAI-compatible server (vLLM, Ollama /v1) takes no num_ctx: the
    // server's own limit applies, so the envelope must not print ours.
    const md = formatReport(report, { ...env, backend: 'openai-compatible @ spark:8000', contextTokens: undefined });
    expect(md).toContain('- context: set by the server · temperature: 0');
    expect(md).not.toContain('32768');
  });
});
