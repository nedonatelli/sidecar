import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../../src/ollama/types.js';
import { getContentText } from '../../src/ollama/types.js';
import { SideCarClient, type ProviderSetting } from '../../src/ollama/client.js';
import { normalizeOllamaHost } from '../../src/ollama/hostUrl.js';
import { handleUserMessage } from '../../src/webview/handlers/chatHandlers.js';

// ---------------------------------------------------------------------------
// LIVE conversations through the real chat path -- layer 2.
//
// Layer 1 (src/webview/handlers/conversation.test.ts) drives handleUserMessage
// against a SCRIPTED model, which proves history is stored right but cannot
// say what a real model does with it. This is the same path with a real model,
// real tools and the real network: the question a user actually asked, "what's
// the weather today?" then "count to 10" -- the conversation that exposed the
// v0.124.0 re-answering bug.
//
// Graded mechanically, never by another model:
//   HARD  history is answered turn by turn (no unanswered prompt, no
//         duplicate), and reply 2 counts 1..10 without mentioning the weather.
//   REPORTED (not asserted -- it is what we want to learn, not a regression
//   bar) what turn 1 did: searched the web, declined, asked for a location, or
//   stated a forecast it could not have known.
//
// Backend: Ollama by default (OLLAMA_HOST, explicit provider -- never URL
// sniffing); SIDECAR_CONV_BACKEND=anthropic with ANTHROPIC_API_KEY for cloud.
// Seeds: SIDECAR_CONV_SEEDS (default "11,22,33"). Results are written to
// .sidecar/logs/eval-conversations/<stamp>.json.
// ---------------------------------------------------------------------------

const BACKEND = process.env.SIDECAR_CONV_BACKEND || 'ollama';
const CLOUD = BACKEND === 'anthropic';
const BASE_URL = CLOUD
  ? 'https://api.anthropic.com'
  : normalizeOllamaHost(process.env.OLLAMA_HOST || '') || 'http://localhost:11434';
const MODEL = process.env.SIDECAR_CONV_MODEL || (CLOUD ? 'claude-sonnet-4-6' : 'gemma4:e4b');
const API_KEY = CLOUD ? process.env.ANTHROPIC_API_KEY || '' : 'ollama';
const SEEDS = (process.env.SIDECAR_CONV_SEEDS || '11,22,33').split(',').map((s) => Number(s.trim()));

async function backendUp(): Promise<boolean> {
  if (CLOUD) return API_KEY !== '';
  try {
    const r = await fetch(`${BASE_URL}/api/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The ChatState the handler needs; everything not under test is a no-op. */
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
    // A tool that needs approval is DENIED: a live eval must not write or run
    // things on this machine. web_search needs no approval, so it can run.
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

const isToolResult = (m: ChatMessage): boolean =>
  m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
const userPrompts = (ms: ChatMessage[]): ChatMessage[] => ms.filter((m) => m.role === 'user' && !isToolResult(m));
const toolNames = (ms: ChatMessage[]): string[] =>
  ms.flatMap((m) =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name)
      : [],
  );
const lastAssistantText = (ms: ChatMessage[]): string => {
  const a = [...ms].reverse().find((m) => m.role === 'assistant' && getContentText(m.content).trim());
  return a ? getContentText(a.content).trim() : '';
};

const WEATHER_WORDS = /weather|forecast|temperature|°|degrees|sunny|rain|cloud|humid|wind/i;
const NO_REALTIME =
  /real[- ]time|don'?t have (access|the ability)|can(?:no|')t (access|check|browse|look up)|unable to (access|check|provide|browse)|no (internet|web) access/i;
const ASKS_LOCATION =
  /your location|where are you|which city|what city|what location|city or (zip|region)|tell me (your|the) (city|location)/i;
const STATES_FORECAST = /-?\d+\s*(°|degrees|º)\s*[FC]?|\b\d+\s*[FC]\b(?![a-z])/;

/** What turn 1 did, mechanically. Several can be true; listed in that order. */
function classifyWeatherTurn(reply: string, tools: string[]): string[] {
  const out: string[] = [];
  if (tools.includes('web_search')) out.push('searched');
  if (tools.some((t) => t !== 'web_search'))
    out.push(`other-tools:${[...new Set(tools.filter((t) => t !== 'web_search'))].join('+')}`);
  if (NO_REALTIME.test(reply)) out.push('said-no-realtime-access');
  if (ASKS_LOCATION.test(reply)) out.push('asked-location');
  if (STATES_FORECAST.test(reply))
    out.push(tools.includes('web_search') ? 'gave-forecast-after-search' : 'gave-forecast-WITHOUT-search');
  if (out.length === 0) out.push('other');
  return out;
}

/** 1..10 in order, as words or digits. */
function countsToTen(reply: string): boolean {
  const nums = (reply.match(/\b(10|[1-9])\b/g) ?? []).map(Number);
  let want = 1;
  for (const n of nums) if (n === want) want++;
  return want > 10;
}

describe(`llm-eval :: live conversation (${BACKEND} ${MODEL})`, () => {
  it(
    'weather today, then count to 10 -- history stays answered and turn 2 does not re-answer turn 1',
    async (ctx) => {
      // No backend, no run: a skip, not a failure (the eval-suite convention).
      if (!(await backendUp())) ctx.skip();
      const results: Record<string, unknown>[] = [];
      const failures: string[] = [];
      const prevSeed = process.env.SIDECAR_AGENT_SEED;
      try {
        for (const seed of SEEDS) {
          process.env.SIDECAR_AGENT_SEED = String(seed);
          const client = new SideCarClient(
            MODEL,
            BASE_URL,
            API_KEY,
            (CLOUD ? 'anthropic' : 'ollama') as ProviderSetting,
          );
          // Record exactly what each model request carried.
          const requests: ChatMessage[][] = [];
          const orig = client.streamChat.bind(client);
          (client as { streamChat: typeof client.streamChat }).streamChat = ((
            msgs: ChatMessage[],
            ...rest: unknown[]
          ) => {
            requests.push(structuredClone(msgs));
            return (orig as (...a: unknown[]) => ReturnType<typeof client.streamChat>)(msgs, ...rest);
          }) as typeof client.streamChat;

          const state = makeState(client);
          const t0 = Date.now();
          await handleUserMessage(state as never, "What's the weather today?");
          const afterTurn1 = state.messages.length;
          const reply1 = lastAssistantText(state.messages);
          const tools1 = toolNames(state.messages);
          const requestsTurn1 = requests.length;

          await handleUserMessage(state as never, 'Count to 10.');
          const turn2 = state.messages.slice(afterTurn1);
          const reply2 = lastAssistantText(state.messages);
          const firstTurn2Request = requests[requestsTurn1];

          const prompts = userPrompts(state.messages).map((m) => getContentText(m.content));
          const r = {
            seed,
            turn1: { reply: reply1, tools: tools1, classified: classifyWeatherTurn(reply1, tools1) },
            turn2: {
              reply: reply2,
              tools: toolNames(turn2),
              countsToTen: countsToTen(reply2),
              mentionsWeather: WEATHER_WORDS.test(reply2),
            },
            // The re-answering bug's signature: the request for turn 2 must carry
            // turn 1's prompt exactly once, already followed by its answer.
            turn2RequestShape: firstTurn2Request?.map((m) => `${m.role}${isToolResult(m) ? ':tool_result' : ''}`),
            historyPrompts: prompts,
            wallMs: Date.now() - t0,
          };
          results.push(r);
          console.log(
            `[conv] seed=${seed} turn1=${r.turn1.classified.join(',')} tools=[${tools1.join(',')}] ` +
              `turn2: counts=${r.turn2.countsToTen} weather=${r.turn2.mentionsWeather}\n` +
              `  reply1: ${reply1.replace(/\s+/g, ' ').slice(0, 220)}\n  reply2: ${reply2.replace(/\s+/g, ' ').slice(0, 160)}`,
          );

          // HARD checks, COLLECTED rather than thrown: an early `expect` ended
          // the loop at the first failing seed, so seed 33 never ran on the
          // first live run. Every seed runs; all failures are reported at once.
          const fail = (what: string) => failures.push(`seed ${seed}: ${what}`);
          // History answered turn by turn, each prompt stored as the user typed it.
          if (prompts.length !== 2) fail(`expected 2 prompts in history, got ${prompts.length}`);
          if (prompts[1] !== 'Count to 10.')
            fail(`turn 2 was not stored as typed: ${JSON.stringify(prompts[1]).slice(0, 160)}`);
          const lastPromptIdx = firstTurn2Request ? firstTurn2Request.map((m) => m.role).lastIndexOf('user') : -1;
          const before = firstTurn2Request?.slice(0, lastPromptIdx) ?? [];
          if (!before.some((m) => m.role === 'assistant' && getContentText(m.content).trim()))
            fail('turn 2 request did not carry an answer to turn 1');
          if (userPrompts(before).length !== 1)
            fail(`turn 2 request carried ${userPrompts(before).length} earlier prompts, not 1`);
          // Turn 2 does what it was asked and does not re-answer turn 1.
          if (!r.turn2.countsToTen) fail('reply 2 did not count 1..10');
          if (r.turn2.mentionsWeather) fail('reply 2 mentions the weather');
        }
        expect(failures, failures.join('\n')).toEqual([]);
      } finally {
        if (prevSeed === undefined) delete process.env.SIDECAR_AGENT_SEED;
        else process.env.SIDECAR_AGENT_SEED = prevSeed;
        const dir = path.join('.sidecar', 'logs', 'eval-conversations');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.${BACKEND}.json`);
        fs.writeFileSync(file, JSON.stringify({ backend: BACKEND, model: MODEL, baseUrl: BASE_URL, results }, null, 1));
        console.log(`[conv] wrote ${file}`);
      }
    },
    SEEDS.length * 6 * 60_000,
  );

  it(
    "answers 'what is today's date?' from the Session block, not from its training data",
    async (ctx) => {
      if (!(await backendUp())) ctx.skip();
      // Pinned to a date the model cannot reach from training: only the prompt's
      // date line can produce it. The Session block is the sole source.
      const prevDate = process.env.SIDECAR_PROMPT_DATE;
      const prevSeed = process.env.SIDECAR_AGENT_SEED;
      process.env.SIDECAR_PROMPT_DATE = '2026-01-15';
      const failures: string[] = [];
      try {
        for (const seed of SEEDS) {
          process.env.SIDECAR_AGENT_SEED = String(seed);
          const client = new SideCarClient(
            MODEL,
            BASE_URL,
            API_KEY,
            (CLOUD ? 'anthropic' : 'ollama') as ProviderSetting,
          );
          const state = makeState(client);
          await handleUserMessage(state as never, "What is today's date?");
          const reply = lastAssistantText(state.messages);
          const ok = /January 15,? 2026|2026-01-15|15 January,? 2026|1\/15\/2026/i.test(reply);
          console.log(`[conv] date seed=${seed} ok=${ok}: ${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
          if (!ok) failures.push(`seed ${seed}: reply did not give the pinned date: ${reply.slice(0, 160)}`);
        }
      } finally {
        if (prevDate === undefined) delete process.env.SIDECAR_PROMPT_DATE;
        else process.env.SIDECAR_PROMPT_DATE = prevDate;
        if (prevSeed === undefined) delete process.env.SIDECAR_AGENT_SEED;
        else process.env.SIDECAR_AGENT_SEED = prevSeed;
      }
      expect(failures, failures.join('\n')).toEqual([]);
    },
    SEEDS.length * 3 * 60_000,
  );
});
