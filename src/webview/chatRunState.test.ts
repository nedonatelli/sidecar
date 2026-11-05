// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Run state across the webview boundary (#419).
//
// - Deleting or editing a message mid-run posted the request, the extension
//   refused it with an `error`, and the error card removed the streaming
//   bubble and cleared loading while the run went on.
// - The plan card's Reject greyed the card and posted nothing, so the
//   extension kept the plan pending.

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');

let sent: any[];
let messagesEl: HTMLElement;

function loadWebview(): void {
  sent = [];
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
    postMessage: (m: any) => sent.push(m),
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
  messagesEl = document.getElementById('messages')!;
}

function deliver(data: unknown): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = data;
  window.dispatchEvent(event);
}

// The stubbed getElementById never finds the typing indicator to remove it, so skip it.
const assistantBubbles = () => messagesEl.querySelectorAll('.message.assistant:not(.error):not(.typing-indicator)');
const loading = () => !document.getElementById('activity-bar')!.classList.contains('hidden');

/** A restored user prompt, then a run that has started streaming its answer. */
function startRun(): HTMLElement {
  deliver({ command: 'init', messages: [{ role: 'user', content: 'fix the bug' }] });
  deliver({ command: 'setLoading', isLoading: true });
  deliver({ command: 'assistantMessage', content: 'Looking at ' });
  expect(assistantBubbles()).toHaveLength(1);
  expect(loading()).toBe(true);
  return messagesEl.querySelector<HTMLElement>('.message.user')!;
}

/** The run is intact: one streaming bubble, still loading, and the next chunk joins it. */
function expectRunIntact(): void {
  expect(loading()).toBe(true);
  expect(messagesEl.querySelector('.message.error')).toBeNull();
  deliver({ command: 'assistantMessage', content: 'the parser.' });
  expect(assistantBubbles()).toHaveLength(1);
  expect(assistantBubbles()[0].textContent).toContain('Looking at the parser.');
}

describe('requests refused mid-run do not end the run', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
  });

  it('deleting a message mid-run posts no deleteMessage and keeps the stream', () => {
    const user = startRun();
    sent.length = 0;
    user.querySelector<HTMLButtonElement>('.message-delete-btn')!.click();
    expect(sent.filter((m) => m.command === 'deleteMessage')).toEqual([]);
    expect(user.isConnected).toBe(true);
    expect(messagesEl.querySelector('.chat-notice')?.textContent).toContain('agent is running');
    expectRunIntact();
  });

  it('resending an edit mid-run posts no editMessage and keeps the stream', () => {
    const user = startRun();
    user.querySelector<HTMLButtonElement>('.message-edit-btn')!.click();
    user.querySelector<HTMLTextAreaElement>('.msg-inline-textarea')!.value = 'fix the other bug';
    sent.length = 0;
    user.querySelector<HTMLButtonElement>('.msg-inline-resend')!.click();
    expect(sent.filter((m) => m.command === 'editMessage')).toEqual([]);
    expect(messagesEl.querySelector('.chat-notice')?.textContent).toContain('agent is running');
    expectRunIntact();
  });

  it("a host notice (e.g. 'Steer rejected') shows without touching the stream", () => {
    startRun();
    deliver({ command: 'notice', content: 'Steer rejected: queue full' });
    expect(messagesEl.querySelector('.chat-notice')?.textContent).toBe('Steer rejected: queue full');
    expectRunIntact();
  });

  it('a genuine run error still ends the run', () => {
    startRun();
    deliver({ command: 'error', content: 'Request failed' });
    expect(loading()).toBe(false);
    expect(assistantBubbles()).toHaveLength(0);
    expect(messagesEl.querySelector('.message.error')?.textContent).toContain('Request failed');
  });

  it('deleting a message outside a run still posts deleteMessage and removes the bubble', () => {
    deliver({ command: 'init', messages: [{ role: 'user', content: 'fix the bug' }] });
    const user = messagesEl.querySelector<HTMLElement>('.message.user')!;
    user.querySelector<HTMLButtonElement>('.message-delete-btn')!.click();
    expect(sent.filter((m) => m.command === 'deleteMessage')).toEqual([{ command: 'deleteMessage', index: 0 }]);
    expect(user.isConnected).toBe(false);
  });
});

describe("the plan card's Reject", () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
  });

  it('posts rejectPlan so the extension drops the pending plan', () => {
    deliver({ command: 'setLoading', isLoading: true });
    deliver({ command: 'assistantMessage', content: '1. Edit the parser' });
    deliver({ command: 'planReady' });
    deliver({ command: 'done' });
    const reject = messagesEl.querySelector<HTMLButtonElement>('.plan-reject')!;
    sent.length = 0;
    reject.click();
    expect(sent).toEqual([{ command: 'rejectPlan' }]);
    expect(reject.disabled).toBe(true);
    expect(messagesEl.querySelector<HTMLButtonElement>('.plan-execute')!.disabled).toBe(true);
  });
});
