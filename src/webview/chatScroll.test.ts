// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Stick-to-bottom behaviour for the chat transcript.
//
// `scrollToBottom()` is called from 20+ places in media/chat.js and is gated on
// a single `userScrolledUp` latch that has to both SET (user scrolls away) and
// CLEAR (user returns, or hits the button). Nothing tested any of it.
//
// This degrades invisibly: no exception, no failing test — just a transcript
// that either stops following the stream, or yanks you to the bottom while you
// are reading scrollback. Both are shipped-agent bugs in the wild (observed in a
// competitor's webview, 2026-08), which is decent evidence the logic is easy to
// break and easy to miss.
//
// happy-dom does no layout, so scrollHeight/clientHeight are 0 and the gap math
// degenerates. The harness defines them explicitly to model a scrollable
// viewport. requestAnimationFrame is stubbed to run synchronously so assertions
// are deterministic rather than timing-dependent.
// ---------------------------------------------------------------------------

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');

const VIEWPORT = 500;
const CONTENT = 1000;
/** scrollTop at which the transcript is exactly at the bottom. */
const AT_BOTTOM = CONTENT - VIEWPORT;

let messagesEl: HTMLElement;
let scrollBtn: HTMLElement;

function loadChatScript(): void {
  const elementCache = new Map<string, HTMLElement>();

  messagesEl = document.createElement('div');
  messagesEl.id = 'messages';
  // Model a viewport: CONTENT tall, VIEWPORT visible. scrollTop stays a plain
  // writable property so the production assignment is observable.
  Object.defineProperty(messagesEl, 'scrollHeight', { get: () => CONTENT, configurable: true });
  Object.defineProperty(messagesEl, 'clientHeight', { get: () => VIEWPORT, configurable: true });
  messagesEl.scrollTop = AT_BOTTOM;
  elementCache.set('messages', messagesEl);

  scrollBtn = document.createElement('div');
  scrollBtn.id = 'scroll-to-bottom';
  elementCache.set('scroll-to-bottom', scrollBtn);

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
    postMessage: vi.fn(),
    getState: () => ({}),
    setState: () => undefined,
  });
  (window as any).SideCar = { githubCards: { render: () => undefined } };
  (window as any).__mermaidSrc = null;
  (window as any).__mermaidEnabled = false;
  (window as any).__backendProfiles = [];
  (window as any).__activeBackendProfileId = null;

  // Synchronous rAF: the scroll listener and scrollToBottom both defer through
  // it, and asserting across real frames would be timing-dependent.
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => {
    cb(0);
    return 0;
  };

  // eslint-disable-next-line no-new-func
  new Function(CHAT_JS)();
}

/** Move the transcript and let the scroll listener observe it. */
function userScrollsTo(scrollTop: number): void {
  messagesEl.scrollTop = scrollTop;
  messagesEl.dispatchEvent(new Event('scroll'));
}

/** Any transcript append that ends in scrollToBottom(). */
function appendContent(): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = { command: 'resumeAvailable' };
  window.dispatchEvent(event);
}

describe('chat transcript stick-to-bottom', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadChatScript();
  });

  it('follows new content when the user is pinned to the bottom', () => {
    userScrollsTo(AT_BOTTOM);
    messagesEl.scrollTop = 0; // simulate content growing above the fold
    appendContent();
    expect(messagesEl.scrollTop).toBe(CONTENT);
  });

  it('does NOT yank a user who has scrolled up to read scrollback', () => {
    userScrollsTo(0);
    appendContent();
    expect(messagesEl.scrollTop).toBe(0);
  });

  it('treats near-bottom (within the 40px threshold) as still pinned', () => {
    // gap = 1000 - 480 - 500 = 20px, inside the threshold.
    userScrollsTo(AT_BOTTOM - 20);
    messagesEl.scrollTop = 0;
    appendContent();
    expect(messagesEl.scrollTop).toBe(CONTENT);
  });

  it('detaches once the user passes the threshold', () => {
    // gap = 1000 - 400 - 500 = 100px, outside the threshold.
    userScrollsTo(AT_BOTTOM - 100);
    appendContent();
    expect(messagesEl.scrollTop).toBe(AT_BOTTOM - 100);
  });

  it('shows the scroll-to-bottom button only while detached', () => {
    userScrollsTo(0);
    expect(scrollBtn.classList.contains('hidden')).toBe(false);
    userScrollsTo(AT_BOTTOM);
    expect(scrollBtn.classList.contains('hidden')).toBe(true);
  });

  it('re-arms following when the user clicks scroll-to-bottom', () => {
    userScrollsTo(0);
    scrollBtn.click();
    expect(messagesEl.scrollTop).toBe(CONTENT);
    expect(scrollBtn.classList.contains('hidden')).toBe(true);

    // The latch must be CLEARED, not just the position reset — otherwise the
    // transcript never follows again for the rest of the session.
    messagesEl.scrollTop = 0;
    appendContent();
    expect(messagesEl.scrollTop).toBe(CONTENT);
  });

  it('resumes following when the user scrolls back down themselves', () => {
    userScrollsTo(0);
    userScrollsTo(AT_BOTTOM);
    messagesEl.scrollTop = 0;
    appendContent();
    expect(messagesEl.scrollTop).toBe(CONTENT);
  });
});
