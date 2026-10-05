import { describe, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../../src/ollama/types.js';
import { getContentText } from '../../src/ollama/types.js';
import { SideCarClient } from '../../src/ollama/client.js';
import { normalizeOllamaHost } from '../../src/ollama/hostUrl.js';
import { handleUserMessage } from '../../src/webview/handlers/chatHandlers.js';

// ---------------------------------------------------------------------------
// Does a LOCAL model know it can search the web -- and does nothing break when
// it cannot?
//
// Live conversation eval, seed 33: asked for the weather, gemma4 said "my tools
// are focused on file system operations". Under local tool trim web_search is
// one of ~70 one-line stubs (`[stub -- call describe_tool('web_search') ...]`),
// so the model often does not notice it. The candidate fix promotes it to full
// schema (~200 prompt tokens). This measures whether that earns its place, and
// what the model does with the offline message, which no test has exercised.
//
// One process per CONDITION -- webSearch caches connectivity at module level,
// so online and offline in one process would contaminate each other:
//   SIDECAR_LOCAL_CORE_EXTRA=web_search   -> catalog "full" (else "stub")
//   SIDECAR_SIMULATE_OFFLINE=1            -> network "offline" (else "online")
// (both switches live on exp/web-search-awareness only).
//
// PRE-REGISTERED (2026-10-05, before any run):
//   primary   online: share of NEEDS_WEB turns that call web_search, stub vs full.
//   secondary unnecessary web_search on CONTROL prompts; turns that state a
//             specific current fact (version, price, temperature) WITHOUT searching.
//   offline   every turn: no exception, a non-empty reply; a turn that tried to
//             search must say search is unavailable, not present a result.
// Graded by fixed rules, never by another model. Results ->
// .sidecar/logs/eval-web-awareness/<stamp>.<condition>.json
// ---------------------------------------------------------------------------

const BASE_URL = normalizeOllamaHost(process.env.OLLAMA_HOST || '') || 'http://localhost:11434';
const MODEL = process.env.SIDECAR_CONV_MODEL || 'gemma4:e4b';
const SEEDS = (process.env.SIDECAR_CONV_SEEDS || '11,22,33').split(',').map((s) => Number(s.trim()));
const CATALOG = (process.env.SIDECAR_LOCAL_CORE_EXTRA ?? '').includes('web_search') ? 'full' : 'stub';
const NETWORK = process.env.SIDECAR_SIMULATE_OFFLINE === '1' ? 'offline' : 'online';

const NEEDS_WEB = [
  "What's the weather today?",
  'What is the latest stable version of TypeScript?',
  "What's new in the most recent Python release?",
  'What is the current price of Bitcoin?',
  'Who won the most recent FIFA World Cup?',
];
const CONTROL = ['Write a Python function that reverses a string.', 'Explain what a closure is in JavaScript.'];

async function backendUp(): Promise<boolean> {
  try {
    return (await fetch(`${BASE_URL}/api/version`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

function makeState(client: SideCarClient) {
  return {
    messages: [] as ChatMessage[],
    client,
    postMessage: vi.fn(),
    saveHistory: vi.fn(),
    autoSave: vi.fn(),
    trimHistory: vi.fn(),
    logMessage: vi.fn(),
    abortController: null as AbortController | null,
    chatGeneration: 0,
    forceShadowNextRun: false,
    pendingQuestion: null as string | null,
    pendingPlan: null as string | null,
    pendingPlanMessages: [] as ChatMessage[],
    pendingPartialAssistant: null,
    pendingSteerSnapshot: null,
    currentSteerQueue: null,
    currentSteerDisposer: null,
    cancelCallbacks: null,
    skillLoader: null,
    context: { extension: { packageJSON: {} } },
    loadSidecarMd: async () => null,
    loadDesignMd: async () => null,
    loadPerDirSidecarMd: async () => [],
    // Approval-gated tools are DENIED: a live eval must not write or run things here.
    requestConfirm: vi.fn().mockResolvedValue('Deny'),
    requestClarification: vi.fn(),
    metricsCollector: {
      startRun: vi.fn(),
      endRun: vi.fn(),
      getCurrentRunTokens: vi.fn().mockReturnValue(0),
      getSpendBreakdown: vi.fn().mockReturnValue({ daily: 0, weekly: 0 }),
      recordToolStart: vi.fn(),
      recordToolEnd: vi.fn(),
      getToolDuration: vi.fn().mockReturnValue(0),
      recordIteration: vi.fn(),
      setTokenEstimate: vi.fn(),
      recordCost: vi.fn(),
    },
    changelog: { hasChanges: () => false },
  };
}

type ToolUse = { name: string; input: Record<string, unknown> };
const toolUses = (ms: ChatMessage[]): ToolUse[] =>
  ms.flatMap((m) =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'tool_use').map((b) => b as unknown as ToolUse)
      : [],
  );
const toolResults = (ms: ChatMessage[]): string[] =>
  ms.flatMap((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'tool_result').map((b) => String((b as { content?: unknown }).content ?? ''))
      : [],
  );
const finalReply = (ms: ChatMessage[]): string => {
  const a = [...ms].reverse().find((m) => m.role === 'assistant' && getContentText(m.content).trim());
  return a ? getContentText(a.content).trim() : '';
};

const SAYS_UNAVAILABLE =
  /offline|no internet|unavailable|not available|can(?:no|')t (access|search|browse|reach)|unable to (access|search|browse|connect)|don'?t have (access|internet)|no (web|internet) access|real[- ]time/i;
// A specific current fact: a version number, a price, or a temperature.
const STATES_SPECIFIC = /\b\d+\.\d+(\.\d+)?\b|\$\s?\d[\d,]*(\.\d+)?|\d+\s*(°|degrees)\s*[FC]?/i;

describe(`llm-eval :: web-search awareness (${MODEL}, catalog=${CATALOG}, network=${NETWORK})`, () => {
  it(
    'does the local model search when it should, and degrade gracefully when it cannot',
    async (ctx) => {
      if (!(await backendUp())) ctx.skip();
      const rows: Record<string, unknown>[] = [];
      const prevSeed = process.env.SIDECAR_AGENT_SEED;
      try {
        for (const seed of SEEDS) {
          process.env.SIDECAR_AGENT_SEED = String(seed);
          for (const prompt of [...NEEDS_WEB, ...CONTROL]) {
            const client = new SideCarClient(MODEL, BASE_URL, 'ollama', 'ollama');
            const state = makeState(client);
            const t0 = Date.now();
            let error: string | null = null;
            try {
              await handleUserMessage(state as never, prompt);
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
            }
            const uses = toolUses(state.messages);
            const reply = finalReply(state.messages);
            const searched = uses.some((u) => u.name === 'web_search');
            const described = uses.some(
              (u) => u.name === 'describe_tool' && JSON.stringify(u.input).includes('web_search'),
            );
            const results = toolResults(state.messages).join('\n');
            const row = {
              seed,
              kind: NEEDS_WEB.includes(prompt) ? 'needs-web' : 'control',
              prompt,
              searched,
              described,
              tools: uses.map((u) => u.name),
              searchSaidOffline: /No internet connection|Still offline/.test(results),
              replySaysUnavailable: SAYS_UNAVAILABLE.test(reply),
              statesSpecificWithoutSearch: !searched && STATES_SPECIFIC.test(reply),
              emptyReply: reply === '',
              error,
              reply: reply.slice(0, 600),
              ms: Date.now() - t0,
            };
            rows.push(row);
            console.log(
              `[web] ${CATALOG}/${NETWORK} s${seed} ${row.kind.padEnd(9)} searched=${searched} described=${described} ` +
                `unavailable=${row.replySaysUnavailable} specific-unsearched=${row.statesSpecificWithoutSearch}` +
                `${error ? ` ERROR=${error}` : ''}  "${prompt.slice(0, 40)}" -> ${reply.replace(/\s+/g, ' ').slice(0, 90)}`,
            );
          }
        }
      } finally {
        if (prevSeed === undefined) delete process.env.SIDECAR_AGENT_SEED;
        else process.env.SIDECAR_AGENT_SEED = prevSeed;
        const dir = path.join('.sidecar', 'logs', 'eval-web-awareness');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.${CATALOG}-${NETWORK}.json`);
        fs.writeFileSync(file, JSON.stringify({ model: MODEL, catalog: CATALOG, network: NETWORK, rows }, null, 1));
        console.log(`[web] wrote ${file}`);
      }
    },
    SEEDS.length * (NEEDS_WEB.length + CONTROL.length) * 4 * 60_000,
  );
});
