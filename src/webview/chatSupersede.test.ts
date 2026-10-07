// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ChatMessage, StreamEvent } from '../ollama/types.js';
import { getContentText } from '../ollama/types.js';
import * as settingsMod from '../config/settings.js';
import * as providerReachability from '../config/providerReachability.js';
import { handleUserMessage } from './handlers/chatHandlers.js';

// ---------------------------------------------------------------------------
// The chat PANEL after a failed message -- both halves wired together.
//
// PR #90 drops a failed, unanswered prompt when the user moves on, and posts
// `init` so the webview re-renders from history. The conversation tests prove
// the history; nothing proved what the panel then SHOWS, and the manual check
// ("stop Ollama, send, restart, send something else") needs someone at the
// screen. So here the real extension handler drives the real media/chat.js:
// every postMessage the handler sends is delivered to the webview, and every
// message the webview sends back is handed to the handler, as in VS Code.
// ---------------------------------------------------------------------------

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');
const baseConfig = settingsMod.getConfig();

type ModelReply = StreamEvent[] | Error;
const answer = (text: string): ModelReply => [
  { type: 'text', text },
  { type: 'stop', stopReason: 'end_turn' },
];

/** The webview: load chat.js; return what it sends to the extension. */
function loadWebview(): { sent: { command: string; text?: string }[]; byId: Map<string, HTMLElement> } {
  const sent: { command: string; text?: string }[] = [];
  const byId = new Map<string, HTMLElement>();
  document.getElementById = ((id: string): HTMLElement => {
    let el = byId.get(id);
    if (!el) {
      el =
        id === 'input' ? document.createElement('textarea') : document.createElement(id === 'send' ? 'button' : 'div');
      el.id = id;
      byId.set(id, el);
      if (id === 'messages') document.body.appendChild(el);
    }
    return el;
  }) as typeof document.getElementById;
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: (m: { command: string; text?: string }) => sent.push(m),
    getState: () => ({}),
    setState: () => undefined,
  });
  (window as any).SideCar = { githubCards: { render: () => undefined } };
  (window as any).__mermaidSrc = null;
  (window as any).__mermaidEnabled = false;
  (window as any).__backendProfiles = [];
  (window as any).__activeBackendProfileId = null;
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => {
    cb(0);
    return 0;
  };
  // eslint-disable-next-line no-new-func
  new Function(CHAT_JS)();
  return { sent, byId };
}

/** Deliver one extension -> webview message, as VS Code does. */
function deliver(data: unknown): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = data;
  window.dispatchEvent(event);
}

/** A scripted model, one reply per streamChat call. */
function scriptedClient(replies: ModelReply[]) {
  return {
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
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const reply = replies.shift();
      if (!reply) throw new Error('the scripted model has no reply left');
      if (reply instanceof Error) throw reply;
      yield* reply;
    },
  };
}

function makeState(client: unknown) {
  return {
    messages: [] as ChatMessage[],
    client,
    // The bridge: everything the handler posts reaches the real webview.
    postMessage: (m: unknown) => deliver(m),
    saveHistory: vi.fn(),
    autoSave: vi.fn(),
    trimHistory: vi.fn(),
    abortController: null as AbortController | null,
    chatGeneration: 0,
    forceShadowNextRun: false,
    pendingQuestion: null as string | null,
    pendingPlan: null,
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

/** The user types `text` and presses Send; the extension handles what the webview posts. */
async function userSends(
  webview: ReturnType<typeof loadWebview>,
  state: ReturnType<typeof makeState>,
  text: string,
): Promise<void> {
  (webview.byId.get('input') as HTMLTextAreaElement).value = text;
  webview.byId.get('send')!.dispatchEvent(new Event('click'));
  const posted = webview.sent.filter((m) => m.command === 'userMessage').at(-1);
  expect(posted?.text, 'the webview did not send the message').toBe(text);
  await handleUserMessage(state as never, text);
}

const panel = () => document.querySelectorAll<HTMLElement>('.message');
const userBubbles = () => [...panel()].filter((d) => d.classList.contains('user'));
const errorCards = () => document.querySelectorAll('.message.error .error-card');
/** A bubble's message text: its stored raw content, else its text minus the action buttons (⎘ ✎ ×). */
const text = (d: HTMLElement): string => {
  if (d.dataset.rawContent) return d.dataset.rawContent.trim();
  const copy = d.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.message-actions').forEach((a) => a.remove());
  return (copy.textContent ?? '').trim();
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(true);
  vi.spyOn(settingsMod, 'getConfig').mockReturnValue({
    ...baseConfig,
    dailyBudget: 0,
    weeklyBudget: 0,
    verboseMode: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('chat panel after a failed message (extension + webview together)', () => {
  it('moving on: the failed bubble and its error card disappear, and every bubble points at the right message', async () => {
    const replies: ModelReply[] = [answer('Sunny and 22°C.'), new Error('500 Internal Server Error'), answer('4.')];
    const state = makeState(scriptedClient(replies));
    const webview = loadWebview();

    await userSends(webview, state, 'what is the weather like today?');
    await userSends(webview, state, 'count to 10'); // the model fails mid-run

    // The scenario reproduced: the failed prompt is on screen with its error card.
    expect(userBubbles().map(text)).toEqual(['what is the weather like today?', 'count to 10']);
    expect(errorCards()).toHaveLength(1);

    await userSends(webview, state, 'what is 2 + 2?'); // the user moves on

    // The panel shows what the model will see: no failed prompt, no stale error.
    expect(userBubbles().map(text)).toEqual(['what is the weather like today?', 'what is 2 + 2?']);
    expect(errorCards()).toHaveLength(0);
    expect([...panel()].some((d) => d.classList.contains('assistant') && text(d).includes('4.'))).toBe(true);

    // Edit/delete use each bubble's msgIndex to index state.messages: every
    // bubble must point at a message with its own text.
    for (const bubble of userBubbles()) {
      const msg = state.messages[Number(bubble.dataset.msgIndex)];
      expect(msg?.role).toBe('user');
      expect(getContentText(msg!.content)).toBe(text(bubble));
    }
  });

  it('Retry: the failed prompt is answered once, and is still one bubble', async () => {
    const replies: ModelReply[] = [
      answer('Sunny and 22°C.'),
      new Error('500 Internal Server Error'),
      answer('1 2 3 4 5 6 7 8 9 10'),
    ];
    const state = makeState(scriptedClient(replies));
    const webview = loadWebview();

    await userSends(webview, state, 'what is the weather like today?');
    await userSends(webview, state, 'count to 10');
    // What both Retry buttons do: re-send the last user bubble's text, adding no bubble.
    await handleUserMessage(state as never, 'count to 10');

    expect(userBubbles().map(text)).toEqual(['what is the weather like today?', 'count to 10']);
    expect([...panel()].some((d) => d.classList.contains('assistant') && text(d).includes('1 2 3'))).toBe(true);
    const counts = state.messages.filter((m) => m.role === 'user' && getContentText(m.content) === 'count to 10');
    expect(counts).toHaveLength(1);
  });
});
