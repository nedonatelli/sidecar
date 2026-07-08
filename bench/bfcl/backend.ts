// ---------------------------------------------------------------------------
// BFCL model backends — thin, direct single-turn function-calling calls.
//
// Like tests/llm-eval/backend.ts, this deliberately does NOT go through
// SideCarClient: BFCL is a *model-level* benchmark (is this model's
// function-calling good?), so we want the shortest path from prompt + tool
// schemas → emitted calls, with no SideCar middleware in between. Each backend
// returns normalized ParsedCall[] so the runner and AST checker are
// backend-agnostic.
//
// Ollama is the primary target (local model selection). Anthropic + OpenAI are
// included for cross-checking against frontier references. Each backend reports
// availability from an env var so the live eval skips cleanly when absent.
// ---------------------------------------------------------------------------

import type { BfclFunctionSchema, ParsedCall } from './types.js';
import type { CallModel } from './runner.js';
import { normalizeSchema } from './schemaUtil.js';
import { buildToolCallSchema, CONSTRAINED_SYSTEM_PROMPT, parseConstrainedContent } from './constrainedSchema.js';
import { parseTextToolCalls } from '../../src/agent/loop/textParsing.js';
import type { ToolDefinition } from '../../src/ollama/types.js';
import { normalizeOllamaHost } from '../../src/ollama/hostUrl.js';

// Re-export so existing importers (and tests) keep resolving normalizeSchema here.
export { normalizeSchema } from './schemaUtil.js';

const SYSTEM_PROMPT =
  'You are a function-calling assistant. If a provided function answers the request, call it with ' +
  'the correct arguments. If none of the functions apply, answer briefly in plain text and do not call any function.';

/** Convert a BFCL function schema to the OpenAI/Ollama `tools` wire shape. */
function toOpenAiTool(fn: BfclFunctionSchema): unknown {
  return {
    type: 'function',
    function: { name: fn.name, description: fn.description ?? '', parameters: normalizeSchema(fn.parameters) },
  };
}

/** Convert a BFCL function schema to the Anthropic `tools` wire shape. */
function toAnthropicTool(fn: BfclFunctionSchema): unknown {
  return { name: fn.name, description: fn.description ?? '', input_schema: normalizeSchema(fn.parameters) };
}

export interface BfclBackend {
  readonly name: string;
  readonly model: string;
  available(): boolean;
  callModel: CallModel;
}

export interface BackendOptions {
  model: string;
  temperature?: number;
  /** num_ctx for Ollama; informational for cloud. */
  contextTokens?: number;
  /** Per-call timeout. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Phase 1: constrain generation to a JSON schema (Ollama `format`) so a
   * malformed call is unsamplable, instead of relying on native tool-calling +
   * post-hoc repair. Ollama only. The BFCL on/off comparison of this flag is the
   * Phase-1 evidence.
   */
  constrained?: boolean;
  /**
   * When true, measure the RAW model only: native `tool_calls`, no SideCar
   * text-call recovery. Local coding models emit calls as text with tool_calls
   * unset, so raw mode scores ~0% — the point of measuring it is the delta vs the
   * default (SideCar-parsed) mode, which quantifies what SideCar's parsing layer
   * adds. Default false: BFCL measures the PRODUCT (model + SideCar recovery),
   * because that is what actually runs.
   */
  rawParsing?: boolean;
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Best-effort: clear on settle is handled by the caller's await; we accept a
  // dangling timer at worst (process is short-lived in the eval).
  void timer;
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  return ctrl.signal;
}

// --- Ollama (primary) ---

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

export function ollamaBackend(opts: BackendOptions): BfclBackend {
  const host = normalizeOllamaHost(process.env.OLLAMA_HOST || '') || 'http://localhost:11434';
  const doFetch = opts.fetchImpl ?? fetch;
  const temperature = opts.temperature ?? 0;
  return {
    name: 'ollama',
    model: opts.model,
    // The local daemon is the default target; we attempt and surface a
    // connection error rather than silently skipping (you invoked the benchmark).
    available: () => true,
    callModel: async (question, functions) => {
      // Constrained path: no native tools; the reply is grammar-forced to a JSON
      // object matching the union tool-call schema, parsed from message.content.
      const body = opts.constrained
        ? {
            model: opts.model,
            stream: false,
            options: { temperature, num_ctx: opts.contextTokens ?? 32_768 },
            format: buildToolCallSchema(functions),
            messages: [
              { role: 'system', content: CONSTRAINED_SYSTEM_PROMPT },
              { role: 'user', content: question },
            ],
          }
        : {
            model: opts.model,
            stream: false,
            options: { temperature, num_ctx: opts.contextTokens ?? 32_768 },
            tools: functions.map(toOpenAiTool),
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: question },
            ],
          };
      const res = await doFetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: withTimeout(opts.timeoutMs ?? 120_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const data = (await res.json()) as { message?: { tool_calls?: OllamaToolCall[]; content?: string } };
      if (opts.constrained) return parseConstrainedContent(data.message?.content ?? '');
      // Non-constrained: prefer native tool_calls. When a local model returns the
      // call as TEXT (tool_calls UNSET — the norm for qwen2.5-coder, devstral, …
      // via /api/chat), recover it with SideCar's OWN parser, so the score
      // reflects the PRODUCT (model + SideCar), which is what actually runs — not
      // the raw model, which scores ~0% here. `rawParsing` opts out to measure
      // that raw baseline; the delta is what SideCar's parsing layer adds.
      const native = normalizeOpenAiStyle(data.message?.tool_calls ?? []);
      if (native.length > 0 || opts.rawParsing) return native;
      return parseTextCalls(data.message?.content ?? '', functions);
    },
  };
}

/**
 * Recover tool calls emitted as TEXT using SideCar's real agent parser
 * (`parseTextToolCalls`) — the exact code path the agent uses at runtime — so the
 * benchmark measures SideCar's actual function-calling capability, not a
 * bench-local reimplementation that could drift from it.
 */
export function parseTextCalls(content: string, functions: BfclFunctionSchema[]): ParsedCall[] {
  if (!content) return [];
  const toolDefs: ToolDefinition[] = functions.map((fn) => ({
    name: fn.name,
    description: fn.description ?? '',
    input_schema: normalizeSchema(fn.parameters) as ToolDefinition['input_schema'],
  }));
  return parseTextToolCalls(content, toolDefs).map((tu) => ({
    name: tu.name,
    args: (tu.input ?? {}) as Record<string, unknown>,
  }));
}

function normalizeOpenAiStyle(calls: OllamaToolCall[]): ParsedCall[] {
  const out: ParsedCall[] = [];
  for (const tc of calls) {
    const name = tc.function?.name;
    if (!name) continue;
    let args = tc.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    out.push({ name, args: args as Record<string, unknown> });
  }
  return out;
}

// --- Anthropic ---

export function anthropicBackend(opts: BackendOptions): BfclBackend {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: 'anthropic',
    model: opts.model,
    available: () => Boolean(process.env.ANTHROPIC_API_KEY),
    callModel: async (question, functions) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
      const res = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: withTimeout(opts.timeoutMs ?? 120_000),
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 1024,
          temperature: opts.temperature ?? 0,
          system: SYSTEM_PROMPT,
          tools: functions.map(toAnthropicTool),
          messages: [{ role: 'user', content: question }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const data = (await res.json()) as {
        content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
      };
      return (data.content ?? [])
        .filter((b) => b.type === 'tool_use' && b.name)
        .map((b) => ({ name: b.name as string, args: b.input ?? {} }));
    },
  };
}

// --- OpenAI ---

interface OpenAiToolCall {
  function?: { name?: string; arguments?: string };
}

export function openAiBackend(opts: BackendOptions): BfclBackend {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: 'openai',
    model: opts.model,
    available: () => Boolean(process.env.OPENAI_API_KEY),
    callModel: async (question, functions) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');
      const res = await doFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: withTimeout(opts.timeoutMs ?? 120_000),
        body: JSON.stringify({
          model: opts.model,
          temperature: opts.temperature ?? 0,
          tools: functions.map(toOpenAiTool),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: question },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { tool_calls?: OpenAiToolCall[] } }>;
      };
      return normalizeOpenAiStyle(data.choices?.[0]?.message?.tool_calls ?? []);
    },
  };
}

/** Re-export so the runner's CallModel type is importable from one place. */
export { normalizeOpenAiStyle as _normalizeOpenAiStyleForTest };
