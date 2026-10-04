import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage, ContentBlock, StreamEvent } from '../../ollama/types.js';
import { getContentText } from '../../ollama/types.js';
import type { Skill } from '../../agent/skillLoader.js';
import * as settingsMod from '../../config/settings.js';
import * as providerReachability from '../../config/providerReachability.js';
import { handleUserMessage, handleRegenerateResponse } from './chatHandlers.js';
import { handleRevisePlan } from './agentHandlers.js';

// ---------------------------------------------------------------------------
// Conversational tests: several user turns through the REAL chat path.
//
// v0.124.0 re-answered earlier prompts. Asked about the weather and then to
// count to 10, the second reply answered the weather again: a text-only turn
// ended the agent loop without its answer entering history, so each new
// prompt followed an apparently unanswered one. Nothing caught it, because
// every eval is a single prompt and every unit test checks one piece — the
// bug only exists ACROSS turns.
//
// So these tests drive handleUserMessage -> runAgentLoop -> back into
// state.messages, turn after turn, against a scripted model that records
// exactly what each request sent it. Only the edges are faked: the model, the
// reachability probe, and (for the sandbox) the git worktree.
//
// A new path is one line: `await expectAnsweredTurn(convo, prompt, ...replies)`
// asserts the request carried the whole answered history plus this prompt,
// and that history now ends with this turn's answer.
// ---------------------------------------------------------------------------

// The sandbox wrapper builds a git worktree. Fake only the worktree; the
// wrapper's own history hand-back and the loop inside it stay real.
const shadowsCreated = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../agent/shadow/shadowWorkspace.js', () => ({
  ShadowWorkspace: function () {
    shadowsCreated.count++;
    return {
      id: 'task-conv0001',
      path: '/mock-workspace/.sidecar/shadows/task-conv0001',
      mainRoot: '/mock-workspace',
      isActive: true,
      create: async () => {},
      diff: async () => '',
      applyToMain: async () => 'applied',
      dispose: async () => {},
    };
  },
}));

const baseConfig = settingsMod.getConfig();

/** What the model does with one request: stream these events, or fail. */
type ModelReply = StreamEvent[] | Error;

const answer = (text: string): ModelReply => [
  { type: 'text', text },
  { type: 'stop', stopReason: 'end_turn' },
];

const toolCall = (id: string, name: string, input: Record<string, unknown>): ModelReply => [
  { type: 'tool_use', toolUse: { type: 'tool_use', id, name, input } },
  { type: 'stop', stopReason: 'tool_use' },
];

/**
 * A model whose replies are scripted one per streamChat call. Each call
 * snapshots the messages it was sent: that snapshot is what the model saw,
 * which is precisely what the re-answering bug corrupted.
 */
function scriptedClient() {
  const replies: ModelReply[] = [];
  const requests: ChatMessage[][] = [];
  const client = {
    getProviderType: () => 'anthropic',
    isLocalOllama: () => false,
    isLocalEndpoint: () => false,
    setTurnOverride: () => {},
    updateConnection: () => {},
    updateModel: () => {},
    updateSystemPrompt: () => {},
    getSystemPrompt: () => '',
    getModel: () => 'scripted-model',
    getRouter: () => null,
    getModelContextLength: async () => 32768,
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone(messages));
      const reply = replies.shift();
      if (!reply) throw new Error(`the scripted model has no reply for request ${requests.length}`);
      if (reply instanceof Error) throw reply;
      yield* reply;
    },
  };
  return { client, replies, requests };
}

function makeState(client: unknown) {
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
    skillLoader: null as { isReady(): boolean; match(text: string): Skill | null } | null,
    context: { extension: { packageJSON: {} } },
    loadSidecarMd: async () => null,
    loadDesignMd: async () => null,
    loadPerDirSidecarMd: async () => [],
    requestConfirm: vi.fn(),
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

type Exchange = { prompt: string; answer: string | null };

const isToolResult = (m: ChatMessage): boolean =>
  Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === 'tool_result');
const hasToolUse = (m: ChatMessage): boolean =>
  Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === 'tool_use');

/**
 * Fold a message list into the conversation the user had: one entry per user
 * prompt, answered by the text-only assistant message that closed its turn,
 * or `null` when nothing did. Tool calls and their results are the turn's
 * work, not the conversation, and fold away. Two prompts in a row, a repeated
 * prompt, and a turn that stopped mid-work all surface as an extra entry or a
 * `null` answer, which a `toEqual` against the expected exchanges then names.
 */
function conversationOf(messages: ChatMessage[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const m of messages) {
    if (m.role === 'user' && !isToolResult(m)) {
      exchanges.push({ prompt: getContentText(m.content), answer: null });
      continue;
    }
    const current = exchanges[exchanges.length - 1];
    if (!current) continue;
    current.answer = m.role === 'assistant' && !hasToolUse(m) ? getContentText(m.content) : null;
  }
  return exchanges;
}

/** History is exactly these exchanges, in order, and ends on an answer. */
function expectAnsweredHistory(messages: ChatMessage[], expected: Exchange[]): void {
  expect(conversationOf(messages)).toEqual(expected);
  expect(messages[messages.length - 1]?.role).toBe('assistant');
}

/**
 * A request carried every earlier exchange exactly once, each prompt followed
 * by its answer, and then the new prompt: nothing unanswered ahead of it for
 * the model to answer again.
 */
function expectPromptedWith(request: ChatMessage[] | undefined, earlier: Exchange[], prompt: string): void {
  expect(request, 'the model was never called for this turn').toBeDefined();
  expect(conversationOf(request!)).toEqual([...earlier, { prompt, answer: null }]);
}

/**
 * A conversation with the scripted model. Each action queues that turn's
 * model replies, runs, checks every reply was consumed, and returns the
 * turn's FIRST request — the one that carries the prior history.
 */
function startConversation() {
  const { client, replies, requests } = scriptedClient();
  const state = makeState(client);
  const run = async (action: () => Promise<void>, turnReplies: ModelReply[]) => {
    replies.push(...turnReplies);
    const before = requests.length;
    await action();
    expect(replies, 'scripted replies left unconsumed').toEqual([]);
    return requests[before] as ChatMessage[] | undefined;
  };
  return {
    state,
    ask: (prompt: string, ...turnReplies: ModelReply[]) =>
      run(() => handleUserMessage(state as never, prompt), turnReplies),
    regenerate: (...turnReplies: ModelReply[]) => run(() => handleRegenerateResponse(state as never), turnReplies),
    revisePlan: (feedback: string, ...turnReplies: ModelReply[]) =>
      run(() => handleRevisePlan(state as never, feedback), turnReplies),
  };
}

type Conversation = ReturnType<typeof startConversation>;

/** The final reply's text — the answer the turn should leave in history. */
function answerTextOf(replies: ModelReply[]): string {
  const last = replies[replies.length - 1];
  const text = Array.isArray(last) ? last.find((e) => e.type === 'text') : undefined;
  if (!text || text.type !== 'text') throw new Error('a turn must end with a text answer');
  return text.text;
}

/** One answered turn: the request saw the whole answered history, and history now ends with this answer. */
async function expectAnsweredTurn(convo: Conversation, prompt: string, ...replies: ModelReply[]): Promise<void> {
  const earlier = conversationOf(convo.state.messages);
  const request = await convo.ask(prompt, ...replies);
  expectPromptedWith(request, earlier, prompt);
  expectAnsweredHistory(convo.state.messages, [...earlier, { prompt, answer: answerTextOf(replies) }]);
}

function useConfig(overrides: Partial<ReturnType<typeof settingsMod.getConfig>> = {}): void {
  vi.spyOn(settingsMod, 'getConfig').mockReturnValue({
    ...baseConfig,
    dailyBudget: 0,
    weeklyBudget: 0,
    verboseMode: false,
    ...overrides,
  });
}

const WEATHER: Exchange = { prompt: 'what is the weather like today?', answer: 'Sunny and 22°C.' };
const COUNT: Exchange = { prompt: 'count to 10', answer: '1 2 3 4 5 6 7 8 9 10' };

/** A conversation that has already had the weather exchange. */
async function afterWeather(): Promise<Conversation> {
  const convo = startConversation();
  await expectAnsweredTurn(convo, WEATHER.prompt, answer(WEATHER.answer!));
  return convo;
}

beforeEach(() => {
  shadowsCreated.count = 0;
  vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(true);
  useConfig();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('conversation history: text-only answers', () => {
  it('weather, then "count to 10": the count request carries the weather ANSWERED, not an open question', async () => {
    // The v0.124.0 report. Without the text-only answer recorded, the count
    // request went out as [weather?, count?] and both were answered.
    const convo = await afterWeather();
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));
    await expectAnsweredTurn(convo, 'now count backwards from 3', answer('3 2 1'));
  });
});

describe('conversation history: tool-using turns', () => {
  it('a turn that reads a file and then answers is followed cleanly by a text-only turn', async () => {
    const convo = startConversation();
    await expectAnsweredTurn(
      convo,
      'what is in notes.txt?',
      toolCall('tc-read-1', 'read_file', { path: 'notes.txt' }),
      answer('notes.txt says "mock file content".'),
    );
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));

    // The tool exchange stayed in history as a pair: the call, then its result.
    const toolUseAt = convo.state.messages.findIndex(hasToolUse);
    expect(toolUseAt).toBeGreaterThan(0);
    expect(isToolResult(convo.state.messages[toolUseAt + 1])).toBe(true);
  });
});

describe('conversation history: sandboxed runs', () => {
  // The loop runs on a copy of the messages. The sandbox wrapper used to hand
  // nothing back, so the chat read its own array back and lost every
  // sandboxed turn. The git worktree is faked (vi.mock above);
  // runAgentLoopInSandbox and the loop inside it are real.

  it("shadowWorkspace.mode 'always': every turn is kept", async () => {
    useConfig({ shadowWorkspaceMode: 'always', shadowWorkspaceAutoCleanup: true });
    const convo = await afterWeather();
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));
    expect(shadowsCreated.count).toBe(2);
  });

  it('a one-off /sandbox turn between ordinary turns is kept', async () => {
    const convo = await afterWeather();
    convo.state.forceShadowNextRun = true;
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));
    expect(shadowsCreated.count).toBe(1);
    await expectAnsweredTurn(convo, 'now count backwards from 3', answer('3 2 1'));
    expect(shadowsCreated.count).toBe(1);
  });
});

describe('conversation history: plan revision', () => {
  it('Revise sends the feedback after the plan it revises', async () => {
    // The plan snapshot Revise resumes from was taken from the caller's
    // array, which the loop never touches, so it held the request but not the
    // plan: the model was asked to revise a plan it could not see.
    useConfig({ agentMode: 'plan' });
    const convo = startConversation();
    const plan = '1. Extract the parser.\n2. Add tests.';
    await expectAnsweredTurn(convo, 'plan a refactor of the parser', answer(plan));
    expect(convo.state.pendingPlan).toBe(plan);

    // handleRevisePlan leaves plan mode for the revision through
    // workspace.getConfiguration, which the vscode mock does not persist.
    useConfig({ agentMode: 'cautious' });
    const feedback = 'Revise the plan based on this feedback: keep the public API';
    const revised = '1. Extract the parser behind the existing API.\n2. Add tests.';
    const request = await convo.revisePlan('keep the public API', answer(revised));

    expectPromptedWith(request, [{ prompt: 'plan a refactor of the parser', answer: plan }], feedback);
    expectAnsweredHistory(convo.state.messages, [
      { prompt: 'plan a refactor of the parser', answer: plan },
      { prompt: feedback, answer: revised },
    ]);
  });
});

describe('conversation history: sends that fail', () => {
  it('a prompt that never reached the model (backend unreachable) is withdrawn', async () => {
    const convo = await afterWeather();

    vi.mocked(providerReachability.isProviderReachable).mockResolvedValue(false);
    vi.useFakeTimers(); // connectWithRetry backs off between attempts
    const failed = convo.ask(COUNT.prompt);
    await vi.runAllTimersAsync();
    expect(await failed, 'the model must not be called').toBeUndefined();
    vi.useRealTimers();

    // Left in, the retyped prompt below would follow an unanswered copy.
    expectAnsweredHistory(convo.state.messages, [WEATHER]);
    vi.mocked(providerReachability.isProviderReachable).mockResolvedValue(true);
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));
  });

  it('a prompt blocked by the spending limit is withdrawn', async () => {
    const convo = await afterWeather();

    useConfig({ dailyBudget: 1 });
    convo.state.metricsCollector.getSpendBreakdown.mockReturnValue({ daily: 1, weekly: 0 });
    expect(await convo.ask(COUNT.prompt), 'the model must not be called').toBeUndefined();

    expectAnsweredHistory(convo.state.messages, [WEATHER]);
    useConfig();
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));
  });

  it('a prompt the model failed on mid-run is kept, and Regenerate answers it exactly once', async () => {
    const convo = await afterWeather();

    // The model saw this prompt and failed on it: kept, so it can be re-run.
    const failedRequest = await convo.ask(COUNT.prompt, new Error('500 Internal Server Error'));
    expectPromptedWith(failedRequest, [WEATHER], COUNT.prompt);
    expect(conversationOf(convo.state.messages)).toEqual([WEATHER, { prompt: COUNT.prompt, answer: null }]);

    // Regenerate cuts history back to before the kept prompt and re-sends it.
    const retried = await convo.regenerate(answer(COUNT.answer!));
    expectPromptedWith(retried, [WEATHER], COUNT.prompt);
    expectAnsweredHistory(convo.state.messages, [WEATHER, COUNT]);
  });

  // BUG (open): the error card's Retry button does not regenerate. For a 500,
  // a timeout, a rate limit or an unclassified error it posts `userMessage`
  // with the last user bubble's text (media/chat.js, errorActionCommand
  // 'retry'), so handleUserMessage pushes the prompt AGAIN behind the copy
  // the failed run kept. The retry request goes out as [weather, count?,
  // count?] and history keeps the unanswered duplicate for good. Flip to `it`
  // once Retry re-runs the kept prompt instead of re-sending it.
  it.fails("the error card's Retry button sends the failed prompt once, not twice", async () => {
    const convo = await afterWeather();
    await convo.ask(COUNT.prompt, new Error('500 Internal Server Error'));

    // What the Retry button does: re-send the last user bubble's text.
    const retried = await convo.ask(COUNT.prompt, answer(COUNT.answer!));

    expectPromptedWith(retried, [WEATHER], COUNT.prompt);
    expectAnsweredHistory(convo.state.messages, [WEATHER, COUNT]);
  });

  // BUG (open, needs a decision): keeping a failed prompt for Retry means a
  // user who moves on instead sends their NEW prompt behind an unanswered
  // one — the v0.124.0 shape exactly, and the model answers both. Keeping it
  // was deliberate (PR #76), so the fix is a design call — e.g. withdraw the
  // kept prompt when the next one is a different message — not a one-liner.
  it.fails('a new prompt after a mid-run failure does not carry the failed prompt unanswered', async () => {
    const convo = await afterWeather();
    await convo.ask(COUNT.prompt, new Error('500 Internal Server Error'));

    const request = await convo.ask('what is 2 + 2?', answer('4.'));

    expectPromptedWith(request, [WEATHER], 'what is 2 + 2?');
  });
});

describe('conversation history: skills that skip the model', () => {
  it('a disableModelInvocation skill reply is saved, so the next request sees that prompt answered', async () => {
    const skill: Skill = {
      id: 'shortcuts',
      name: 'shortcuts',
      description: 'Lists keyboard shortcuts',
      content: 'Ctrl+Shift+P opens the command palette.',
      source: 'builtin',
      filePath: '/builtin/shortcuts.md',
      disableModelInvocation: true,
    };
    const convo = await afterWeather();
    convo.state.skillLoader = {
      isReady: () => true,
      match: (text) => (text.startsWith('/shortcuts') ? skill : null),
    };

    // No model call: the skill body IS the reply.
    expect(await convo.ask('/shortcuts'), 'the model must not be called').toBeUndefined();
    expectAnsweredHistory(convo.state.messages, [WEATHER, { prompt: '/shortcuts', answer: skill.content }]);
    await expectAnsweredTurn(convo, COUNT.prompt, answer(COUNT.answer!));
  });
});
