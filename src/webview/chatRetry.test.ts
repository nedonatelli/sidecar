// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// The error cards' Retry buttons (#360).
//
// The host treats a resend as a retry only when its text equals the kept
// unanswered prompt (#90). Both buttons used to send the last user bubble's
// textContent, which ends in the bubble's copy/edit/delete glyphs, so that
// match never fired and Retry became a new prompt. The host tests call
// handleUserMessage directly, so only a test of the button itself covers this.
// ---------------------------------------------------------------------------

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');

let postMessage: ReturnType<typeof vi.fn>;
let messagesEl: HTMLElement;

function loadChatScript(): void {
  const elementCache = new Map<string, HTMLElement>();
  messagesEl = document.createElement('div');
  messagesEl.id = 'messages';
  elementCache.set('messages', messagesEl);
  document.getElementById = ((id: string): HTMLElement => {
    let el = elementCache.get(id);
    if (!el) {
      el = id === 'input' ? document.createElement('textarea') : document.createElement('div');
      el.id = id;
      elementCache.set(id, el);
    }
    return el;
  }) as typeof document.getElementById;

  postMessage = vi.fn();
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage, getState: () => ({}), setState: () => undefined });
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
}

function hostSends(data: Record<string, unknown>): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = data;
  window.dispatchEvent(event);
}

function retryButtons(): HTMLButtonElement[] {
  return [...messagesEl.querySelectorAll<HTMLButtonElement>('.error-action-btn')].filter(
    (b) => b.textContent === 'Retry',
  );
}

function sentUserMessages(): unknown[] {
  return postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m && m.command === 'userMessage');
}

describe('error-card Retry', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadChatScript();
    hostSends({ command: 'init', messages: [{ role: 'user', content: 'count to 10' }] });
    // The bubble carries its action buttons, so its textContent is not the prompt.
    const bubble = messagesEl.querySelector<HTMLElement>('.message.user')!;
    expect(bubble.textContent).not.toBe('count to 10');
    postMessage.mockClear();
  });

  it('the generic error card re-sends the prompt exactly, without the button glyphs', () => {
    hostSends({ command: 'error', content: 'Request failed', errorAction: 'Retry', errorActionCommand: 'retry' });
    retryButtons()[0].click();
    expect(sentUserMessages()).toEqual([{ command: 'userMessage', text: 'count to 10' }]);
  });

  it('the connection error card re-sends the prompt exactly', () => {
    hostSends({
      command: 'error',
      content: 'Cannot reach the backend',
      errorType: 'connection',
      errorAction: 'Open Settings',
      errorActionCommand: 'openSettings',
    });
    retryButtons()[0].click();
    expect(sentUserMessages()).toEqual([{ command: 'userMessage', text: 'count to 10' }]);
  });

  it('re-sends the prompt of a bubble the virtualizer has emptied', () => {
    const bubble = messagesEl.querySelector<HTMLElement>('.message.user')!;
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
    hostSends({ command: 'error', content: 'Request failed', errorAction: 'Retry', errorActionCommand: 'retry' });
    retryButtons()[0].click();
    expect(sentUserMessages()).toEqual([{ command: 'userMessage', text: 'count to 10' }]);
  });
});
