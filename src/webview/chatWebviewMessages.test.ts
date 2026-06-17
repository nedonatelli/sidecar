// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Render-level tests for the chat webview's incoming-message dispatcher.
//
// media/chat.js is a plain-JS IIFE that runs in the VS Code webview (browser)
// context — outside tsc and, until v0.113.8, outside eslint. That blind spot
// let three dead `suggestNextSteps` bugs ship (undefined `message`, undefined
// `chatMessages` container, wrong post-message shape). `no-undef` linting now
// catches the undefined-identifier class; this test catches the message-shape
// + render-regression class that lint cannot see.
//
// Strategy: load the real chat.js into happy-dom with a permissive
// getElementById (auto-creates any element the IIFE grabs at load, so no
// null-deref on init), then dispatch a `message` event and assert on the DOM
// + the postMessage contract.
// ---------------------------------------------------------------------------

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');

let postMessage: ReturnType<typeof vi.fn>;
let messagesEl: HTMLElement;

function loadChatScript(): void {
  postMessage = vi.fn();
  const elementCache = new Map<string, HTMLElement>();
  messagesEl = document.createElement('div');
  messagesEl.id = 'messages';
  elementCache.set('messages', messagesEl);

  // Auto-create any element the IIFE looks up at load so init never
  // null-derefs on an id this test didn't pre-build.
  document.getElementById = ((id: string): HTMLElement => {
    let el = elementCache.get(id);
    if (!el) {
      el = id === 'input' ? document.createElement('textarea') : document.createElement('div');
      el.id = id;
      elementCache.set(id, el);
    }
    return el;
  }) as typeof document.getElementById;

  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage,
    getState: () => ({}),
    setState: () => undefined,
  });
  (window as any).SideCar = { githubCards: { render: () => undefined } };
  (window as any).__mermaidSrc = null;
  (window as any).__mermaidEnabled = false;
  (window as any).__backendProfiles = [];
  (window as any).__activeBackendProfileId = null;

  // Execute the IIFE in the global (happy-dom) scope. This deliberately
  // evaluates the shipped webview script so the test exercises real code.
  // eslint-disable-next-line no-new-func
  new Function(CHAT_JS)();
}

function postToWebview(data: Record<string, unknown>): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = data;
  window.dispatchEvent(event);
}

describe('chat webview message dispatcher', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadChatScript();
  });

  it('renders suggestNextSteps as clickable buttons', () => {
    postToWebview({ command: 'suggestNextSteps', suggestions: ['Run it', 'Answer inline'] });
    const buttons = messagesEl.querySelectorAll('.next-step-btn');
    expect(buttons).toHaveLength(2);
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(['Run it', 'Answer inline']);
  });

  it('clicking a suggestion posts a userMessage with the correct shape', () => {
    postToWebview({ command: 'suggestNextSteps', suggestions: ['Run it'] });
    const btn = messagesEl.querySelector('.next-step-btn') as HTMLButtonElement;
    btn.click();
    expect(postMessage).toHaveBeenCalledWith({ command: 'userMessage', text: 'Run it' });
  });

  it('renders nothing for an empty suggestion list', () => {
    postToWebview({ command: 'suggestNextSteps', suggestions: [] });
    expect(messagesEl.querySelectorAll('.next-step-btn')).toHaveLength(0);
  });
});
