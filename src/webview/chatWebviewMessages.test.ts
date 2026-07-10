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

  describe('indexingStatus banner (activation feedback)', () => {
    it('shows the banner with the detail text while indexing', () => {
      postToWebview({
        command: 'indexingStatus',
        indexingPhase: 'indexing',
        indexingDetail: 'Indexing 5713 changed symbols…',
      });
      const banner = document.querySelector('#indexing-banner');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('Indexing 5713 changed symbols…');
    });

    it('updates the detail in place on a second indexing message', () => {
      postToWebview({ command: 'indexingStatus', indexingPhase: 'indexing', indexingDetail: 'Indexing workspace…' });
      postToWebview({
        command: 'indexingStatus',
        indexingPhase: 'indexing',
        indexingDetail: 'Indexing 42 changed symbols…',
      });
      const banners = document.querySelectorAll('#indexing-banner');
      expect(banners).toHaveLength(1);
      expect(banners[0].textContent).toContain('42 changed symbols');
    });

    it('removes the banner on ready', () => {
      postToWebview({ command: 'indexingStatus', indexingPhase: 'indexing', indexingDetail: 'Indexing workspace…' });
      postToWebview({ command: 'indexingStatus', indexingPhase: 'ready' });
      expect(document.querySelector('#indexing-banner')).toBeNull();
    });

    it('falls back to a generic message with no detail', () => {
      postToWebview({ command: 'indexingStatus', indexingPhase: 'indexing' });
      expect(document.querySelector('#indexing-banner')!.textContent).toContain('indexing your workspace');
    });
  });

  // Regression: the webview stamps user bubbles with a local counter that the
  // extension trusts as a direct index into state.messages. A model turn appends
  // assistant + tool entries the webview never counts, so without the `done`
  // resync the next user bubble drifts and delete targets the wrong message.
  describe('message-index alignment across a turn (msgIndex drift)', () => {
    function lastUserBubbleIndex(): string | undefined {
      const users = messagesEl.querySelectorAll('.message.user');
      return (users[users.length - 1] as HTMLElement | undefined)?.dataset.msgIndex;
    }

    it("resyncs the counter to the extension's transcript length on done", () => {
      // Restore a 2-message transcript: indices 0 (user) and 1 (assistant).
      postToWebview({
        command: 'init',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      });

      // User sends msg #3 → stamped index 2 (correct: state.messages.length was 2).
      postToWebview({ command: 'addUserMessage', content: 'do a task' });
      expect(lastUserBubbleIndex()).toBe('2');

      // The turn ran: extension appended assistant + tool_use + tool_result +
      // final assistant, so state.messages is now length 6 — none of which the
      // webview counted. done carries the authoritative length.
      postToWebview({ command: 'done', messageCount: 6 });

      // Next user message must be stamped 6 (its true state.messages index),
      // not the stale 3 the un-resynced local counter would have produced.
      postToWebview({ command: 'addUserMessage', content: 'another task' });
      expect(lastUserBubbleIndex()).toBe('6');
    });

    it('deletes the correctly-aligned index after a turn', () => {
      postToWebview({ command: 'init', messages: [{ role: 'user', content: 'hi' }] });
      postToWebview({ command: 'addUserMessage', content: 'task' }); // index 1
      postToWebview({ command: 'done', messageCount: 4 }); // turn grew transcript to 4
      postToWebview({ command: 'addUserMessage', content: 'next' }); // must be index 4

      const users = messagesEl.querySelectorAll('.message.user');
      const lastUser = users[users.length - 1] as HTMLElement;
      const deleteBtn = lastUser.querySelector('.message-delete-btn') as HTMLButtonElement;
      deleteBtn.click();

      expect(postMessage).toHaveBeenCalledWith({ command: 'deleteMessage', index: 4 });
    });

    it('leaves the counter untouched when done carries no messageCount', () => {
      postToWebview({ command: 'init', messages: [{ role: 'user', content: 'hi' }] });
      postToWebview({ command: 'addUserMessage', content: 'task' }); // index 1
      postToWebview({ command: 'done' }); // legacy done, no count
      postToWebview({ command: 'addUserMessage', content: 'next' });
      // Counter simply continues (2) — no crash, no NaN from a missing field.
      expect(lastUserBubbleIndex()).toBe('2');
    });
  });

  // Security: tool results are rendered as markup ONLY when the extension flags
  // them isHtml. Content-sniffing (any output containing an SVG marker) was a
  // UI-spoofing injection surface — reachable via read_file on a repo .svg.
  describe('toolResult HTML gating (injection surface)', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>pwn</text></svg>';

    it('renders untrusted SVG-bearing output as text, not markup', () => {
      postToWebview({ command: 'toolResult', toolName: 'read_file', content: SVG /* isHtml omitted */ });
      // No markup injected: the raw string shows as text, and no real <svg> node exists.
      expect(messagesEl.querySelector('.tool-result-viz')).toBeNull();
      expect(messagesEl.querySelector('svg')).toBeNull();
      expect(messagesEl.textContent).toContain('<svg');
    });

    it('renders trusted HTML output as markup when isHtml is set', () => {
      postToWebview({
        command: 'toolResult',
        toolName: 'db_query',
        content: '<div class="sidecar-db-result"><table></table></div>',
        isHtml: true,
      });
      const viz = messagesEl.querySelector('.tool-result-viz');
      expect(viz).not.toBeNull();
      expect(viz!.querySelector('table')).not.toBeNull();
    });
  });
});
