import { describe, it, expect } from 'vitest';
import { SideCarClient } from '../../src/ollama/client.js';
import { TOOL_REGISTRY } from '../../src/agent/tools.js';
import { validateToolInput } from '../../src/agent/executor/inputValidator.js';
import { remapParamSynonyms, coerceParamTypes } from '../../src/agent/executor/paramRemap.js';
import { resolveToolNameAlias } from '../../src/agent/executor/toolNameAlias.js';
import { parseTextToolCallsCleaned } from '../../src/agent/loop/textParsing.js';
import { pickAgentBackend, DEFAULT_CASE_TIMEOUT_MS } from './agentHarness.js';
import { TOOL_SURFACE_CASES, schemasFor, type ToolSurfaceCase } from './toolSurfaceCases.js';
import type { ToolUseContentBlock } from '../../src/ollama/types.js';

// ---------------------------------------------------------------------------
// Tool-surface eval — one model call per case, no agent loop.
//
//   SIDECAR_EVAL_MODEL=gemma4:e4b npx vitest run --config vitest.eval.config.ts \
//     tests/llm-eval/toolSurface.eval.ts
//
// Measures whether SideCar's ADVERTISED tool surface is expressible, per tool,
// per model. Seconds per case instead of the ~10 minutes an agent-loop case
// costs, because the question — "can the model fill this schema" — needs
// exactly one turn to answer.
//
// Reports four numbers per case, and the gap between the middle two is the
// point:
//   picked     — did it call the expected tool at all?
//   raw-valid  — did the emission pass real schema validation UNREPAIRED?
//   valid      — did it pass after paramRemap + coerceParamTypes?
//   expresses  — do the arguments actually carry the intent?
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();
const MODEL = process.env.SIDECAR_EVAL_MODEL;

/** WHY a case failed. One bit ("FAIL") sent me hand-probing with curl three
 *  times yesterday; these four need entirely different fixes — no-call is a
 *  prompt problem, wrong-tool a description problem, malformed a schema
 *  problem, wrong-intent a semantics problem. */
type Outcome = 'ok' | 'no-call' | 'wrong-tool' | 'malformed' | 'wrong-intent';

/** How the call reached us. Discovered the hard way: qwen2.5-coder emits
 *  well-formed calls as JSON in the CONTENT field, and an eval that counted
 *  only native tool_calls scored it 0/7 for a model that works in production.
 *  Recording this measures how load-bearing parseTextToolCallsCleaned is. */
type Protocol = 'native' | 'text' | 'thinking' | 'none';

interface CaseResult {
  id: string;
  tool: string;
  picked: string | null;
  protocol: Protocol;
  outcome: Outcome;
  rawValid: boolean;
  valid: boolean;
  expressesFail: string | null;
  repairs: string[];
  /** Verbatim emission, kept ONLY on failure — so diagnosing does not mean
   *  re-running the model by hand. */
  rawEmission?: string;
}

const results: CaseResult[] = [];

function systemPromptFor(c: ToolSurfaceCase): string {
  const files = Object.keys(c.workspace ?? {});
  return (
    'You are a coding agent working in a project. Use the provided tools to act; ' +
    'do not describe what you would do, just call the right tool.\n' +
    (files.length ? `\nFiles in the workspace: ${files.join(', ')}\n` : '')
  );
}

async function runCase(c: ToolSurfaceCase): Promise<CaseResult> {
  const all = TOOL_REGISTRY.map((t) => t.definition);
  const tools = schemasFor(c, all);
  const client = new SideCarClient(MODEL ?? backend!.defaultModel(), backend!.baseUrl(), backend!.apiKey());

  const calls: ToolUseContentBlock[] = [];
  let text = '';
  // Reasoning models emit `thinking` events, not `text`. Accumulating only text
  // made deepseek-r1 look like it returned NOTHING for 5 of 7 cases — the third
  // emission path this harness has been blind to (after native tool_calls and
  // the text protocol). Captured so a no-call can be told apart from a
  // harness that was not listening.
  let thinking = '';
  for await (const ev of client.streamChat(
    [{ role: 'user', content: c.task }],
    undefined,
    tools,
    systemPromptFor(c),
    MODEL,
  )) {
    if (ev.type === 'tool_use') calls.push(ev.toolUse);
    else if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'thinking') thinking += ev.thinking;
  }
  // TEXT-PROTOCOL CALLS COUNT. Many models emit the call as JSON in the content
  // field rather than a native tool_calls array — qwen2.5-coder returns a
  // perfectly well-formed `{"name":"read_file","arguments":{...}}` that way. The
  // agent loop parses those (streamTurn -> parseTextToolCallsCleaned), so an
  // eval that only counted native events reported 0/7 for a model that works
  // fine in production. Measure what the PRODUCTION path sees.
  let protocol: Protocol = calls.length > 0 ? 'native' : 'none';
  if (calls.length === 0 && text.trim()) {
    const { calls: parsed } = parseTextToolCallsCleaned(text, tools, { callExpressions: true });
    calls.push(...parsed);
    if (parsed.length > 0) protocol = 'text';
  }
  // Last resort: a reasoning model that never left its thinking block. The
  // production loop does NOT parse calls out of thinking, so anything found
  // here is a finding about the harness/loop, not a working call — it is
  // recorded as `thinking` protocol so it can never be mistaken for a success.
  if (calls.length === 0 && thinking.trim()) {
    const { calls: parsed } = parseTextToolCallsCleaned(thinking, tools, { callExpressions: true });
    if (parsed.length > 0) protocol = 'thinking';
  }

  // Tool-name aliasing is the FIRST thing the executor does (executor.ts:132),
  // so a model emitting `create_file` reaches write_file in production. Scoring
  // the raw name called deepseek-r1 wrong for a call that would have worked —
  // the third production repair this harness was measuring without.
  for (const t of calls) t.name = resolveToolNameAlias(t.name);
  const hit = calls.find((t) => t.name === c.tool) ?? calls[0] ?? null;
  const res: CaseResult = {
    id: c.id,
    tool: c.tool,
    picked: hit?.name ?? null,
    protocol,
    outcome: 'ok',
    rawValid: false,
    valid: false,
    expressesFail: null,
    repairs: [],
  };
  if (!hit) {
    res.outcome = 'no-call';
    res.expressesFail = 'no tool call';
    res.rawEmission = (text.trim() ? `TEXT: ${text}` : thinking.trim() ? `THINKING-ONLY: ${thinking}` : '(nothing emitted)').slice(0, 400);
    return res;
  }
  if (hit.name !== c.tool) {
    res.outcome = 'wrong-tool';
    res.expressesFail = `called ${hit.name} instead`;
    res.rawEmission = JSON.stringify({ name: hit.name, input: hit.input }).slice(0, 400);
    return res;
  }

  const schema = tools.find((d) => d.name === c.tool)!.input_schema;
  // RAW: exactly what the model emitted, before any repair.
  res.rawValid = validateToolInput(hit.input, schema) === null;

  // REPAIRED: the production path — synonyms remapped, types coerced.
  const remap = remapParamSynonyms(hit.input, schema);
  const coerce = coerceParamTypes(remap.input, schema);
  res.repairs = [...remap.notes, ...coerce.notes];
  const repaired = coerce.input as Record<string, unknown>;
  res.valid = validateToolInput(repaired, schema) === null;

  res.expressesFail = res.valid ? c.expresses(repaired) : validateToolInput(repaired, schema);
  if (!res.valid) res.outcome = 'malformed';
  else if (res.expressesFail) res.outcome = 'wrong-intent';
  if (res.outcome !== 'ok') res.rawEmission = JSON.stringify(hit.input).slice(0, 400);
  return res;
}

describe.skipIf(!backend)('llm-eval :: tool surface', () => {
  for (const c of TOOL_SURFACE_CASES) {
    it(
      `${c.id} — ${c.tool}`,
      async () => {
        const r = await runCase(c);
        results.push(r);
        const detail =
          `${r.outcome.toUpperCase()} via=${r.protocol} picked=${r.picked ?? 'none'} ` +
          `rawValid=${r.rawValid} valid=${r.valid}` +
          (r.repairs.length ? `\n    repaired by scaffold: ${r.repairs.join('; ')}` : '') +
          (r.expressesFail ? `\n    why: ${r.expressesFail}` : '') +
          (r.rawEmission ? `\n    emitted: ${r.rawEmission}` : '');
        // eslint-disable-next-line no-console -- eval output is the product
        console.log(`  ${c.id}: ${detail}`);
        expect(r.picked, `${c.id}: expected ${c.tool}, got ${r.picked ?? 'no call'}`).toBe(c.tool);
        expect(r.valid, `${c.id}: input invalid even after repair`).toBe(true);
        expect(r.expressesFail, `${c.id}: ${r.expressesFail}`).toBeNull();
      },
      DEFAULT_CASE_TIMEOUT_MS,
    );
  }

  it('summary', () => {
    if (results.length === 0) return;
    const n = results.length;
    const picked = results.filter((r) => r.picked === r.tool).length;
    const rawValid = results.filter((r) => r.rawValid).length;
    const valid = results.filter((r) => r.valid).length;
    const expresses = results.filter((r) => r.expressesFail === null).length;
    const savedByRepair = results.filter((r) => !r.rawValid && r.valid).length;
    const byOutcome = results.reduce<Record<string, number>>((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {});
    const byProtocol = results.reduce<Record<string, number>>((a, r) => ((a[r.protocol] = (a[r.protocol] ?? 0) + 1), a), {});
    const lines = [
      '',
      `===== TOOL SURFACE :: ${MODEL ?? backend!.defaultModel()} =====`,
      `  right tool picked : ${picked}/${n}`,
      `  valid RAW         : ${rawValid}/${n}`,
      `  valid after repair: ${valid}/${n}`,
      `  expresses intent  : ${expresses}/${n}`,
      `  saved by repair   : ${savedByRepair}  ← how much the scaffold is earning`,
      `  outcomes          : ${Object.entries(byOutcome).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      `  call protocol     : ${Object.entries(byProtocol).map(([k, v]) => `${k}=${v}`).join(' ')}` +
        (byProtocol.text ? '   ← text-parsed calls would score ZERO without parseTextToolCallsCleaned' : ''),
      '',
    ];
    for (const r of results) {
      const mark = r.outcome === 'ok' ? 'ok  ' : r.outcome.padEnd(4);
      lines.push(
        `  ${mark} ${r.id.padEnd(24)} ${(r.picked ?? 'none').padEnd(16)} via=${r.protocol}` +
          `${r.repairs.length ? '  [repaired]' : ''}${r.expressesFail ? `  — ${r.expressesFail}` : ''}`,
      );
    }
    // eslint-disable-next-line no-console -- eval output is the product
    console.log(lines.join('\n'));
  });
});
