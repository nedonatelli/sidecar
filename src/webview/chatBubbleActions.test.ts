// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// A chat bubble's buttons across the webview boundary (#419).
//
// - ↻ on any answer regenerated the latest turn.
// - Bubbles for slash commands and small talk took message indices that had
//   no history entry, so a later delete or edit hit the wrong message.
// - Retry and Edit dropped the files attached to a prompt.
// - After Cancel on an inline edit, the bubble's buttons did nothing.
// - A bubble the virtualizer rehydrated came back with the wrong buttons and
//   without its plan buttons.

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');

let sent: any[];
let messagesEl: HTMLElement;
let input: HTMLTextAreaElement;

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
  input = document.getElementById('input') as HTMLTextAreaElement;
}

function deliver(data: unknown): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = data;
  window.dispatchEvent(event);
}

function type(text: string): void {
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

const bubbles = (sel: string) => [...messagesEl.querySelectorAll<HTMLElement>(sel)];
const notice = () => messagesEl.querySelector('.chat-notice')?.textContent ?? '';

describe('↻ regenerates only the latest response', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
    deliver({
      command: 'init',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'second answer' },
      ],
    });
    sent.length = 0;
  });

  it("an older answer's ↻ posts nothing and says why", () => {
    bubbles('.message.assistant')[0].querySelector<HTMLButtonElement>('.message-regen-btn')!.click();
    expect(sent).toEqual([]);
    expect(notice()).toContain('Only the latest response');
  });

  it("the latest answer's ↻ regenerates", () => {
    bubbles('.message.assistant')[1].querySelector<HTMLButtonElement>('.message-regen-btn')!.click();
    expect(sent).toEqual([{ command: 'regenerateResponse' }]);
  });

  it('is refused while a run is going', () => {
    deliver({ command: 'setLoading', isLoading: true });
    sent.length = 0;
    bubbles('.message.assistant')[1].querySelector<HTMLButtonElement>('.message-regen-btn')!.click();
    expect(sent).toEqual([]);
    expect(notice()).toContain('agent is running');
  });
});

describe('bubbles with no history entry take no message index', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
    deliver({
      command: 'init',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
      ],
    });
  });

  it('a /help exchange takes none, so the next prompt gets the next history index', () => {
    type('/help');
    const [, helpPrompt] = bubbles('.message.user');
    expect(helpPrompt.textContent).toContain('/help');
    expect(helpPrompt.dataset.msgIndex).toBeUndefined();
    // Edit would have sent "/help" to the model as a prompt.
    expect(helpPrompt.querySelector('.message-edit-btn')).toBeNull();
    expect(bubbles('.message.assistant')[1].dataset.msgIndex).toBeUndefined();

    type('fix the bug');
    expect(bubbles('.message.user')[2].dataset.msgIndex).toBe('2');
  });

  it('a command the extension handles (/usage) takes none', () => {
    type('/usage');
    expect(sent.some((m) => m.command === 'usage')).toBe(true);
    expect(bubbles('.message.user')[1].dataset.msgIndex).toBeUndefined();
    type('fix the bug');
    expect(bubbles('.message.user')[2].dataset.msgIndex).toBe('2');
  });

  it('small talk the extension answers itself loses its index when the reply reports the history length', () => {
    type('hi');
    const hi = bubbles('.message.user')[1];
    expect(hi.dataset.msgIndex).toBe('2');
    deliver({ command: 'assistantMessage', content: 'Hi! Tell me what you would like to do.' });
    deliver({ command: 'done', messageCount: 2 });
    expect(hi.dataset.msgIndex).toBeUndefined();
    // The prompt still in history keeps its index.
    expect(bubbles('.message.user')[0].dataset.msgIndex).toBe('0');

    type('fix the bug');
    const prompt = bubbles('.message.user')[2];
    expect(prompt.dataset.msgIndex).toBe('2');
    // Deleting "hi" used to delete this prompt.
    sent.length = 0;
    hi.querySelector<HTMLButtonElement>('.message-delete-btn')!.click();
    expect(sent.filter((m) => m.command === 'deleteMessage')).toEqual([]);
  });
});

describe('Retry and Edit keep the files attached to a prompt', () => {
  const block = '[File: a.ts]\n```\nconst a = 1;\n```\n\n';

  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
    deliver({ command: 'fileAttached', fileName: 'a.ts', fileContent: 'const a = 1;' });
    type('why is a 1?');
    expect(sent.filter((m) => m.command === 'userMessage').map((m) => m.text)).toEqual([block + 'why is a 1?']);
    sent.length = 0;
  });

  it('Retry re-sends the text with the file, the way the extension kept it', () => {
    deliver({ command: 'error', content: 'Request failed', errorAction: 'Retry', errorActionCommand: 'retry' });
    [...messagesEl.querySelectorAll<HTMLButtonElement>('.error-action-btn')]
      .find((b) => b.textContent === 'Retry')!
      .click();
    expect(sent.filter((m) => m.command === 'userMessage')).toEqual([
      { command: 'userMessage', text: block + 'why is a 1?' },
    ]);
  });

  it('Edit shows the typed text and resends it with the file', () => {
    const prompt = bubbles('.message.user')[0];
    prompt.querySelector<HTMLButtonElement>('.message-edit-btn')!.click();
    const textarea = prompt.querySelector<HTMLTextAreaElement>('.msg-inline-textarea')!;
    expect(textarea.value).toBe('why is a 1?');
    textarea.value = 'why is a one?';
    prompt.querySelector<HTMLButtonElement>('.msg-inline-resend')!.click();
    expect(sent.filter((m) => m.command === 'editMessage')).toEqual([
      { command: 'editMessage', index: 0, text: block + 'why is a one?' },
    ]);
  });
});

describe('Cancel on an inline edit', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
    deliver({ command: 'init', messages: [{ role: 'user', content: 'fix the bug' }] });
  });

  it("leaves the bubble's buttons working", () => {
    const prompt = bubbles('.message.user')[0];
    prompt.querySelector<HTMLButtonElement>('.message-edit-btn')!.click();
    prompt.querySelector<HTMLButtonElement>('.msg-inline-cancel')!.click();
    expect(prompt.textContent).toContain('fix the bug');
    expect(prompt.querySelector<HTMLElement>('.message-actions')!.style.display).toBe('');

    // Edit opens the editor again, and delete posts.
    prompt.querySelector<HTMLButtonElement>('.message-edit-btn')!.click();
    expect(prompt.querySelector('.msg-inline-textarea')).not.toBeNull();
    prompt.querySelector<HTMLButtonElement>('.msg-inline-cancel')!.click();
    sent.length = 0;
    prompt.querySelector<HTMLButtonElement>('.message-delete-btn')!.click();
    expect(sent).toEqual([{ command: 'deleteMessage', index: 0 }]);
  });
});

describe('a bubble the virtualizer rehydrates', () => {
  let observers: Array<{ cb: (entries: any[]) => void; observed: Set<Element> }>;
  const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  beforeEach(() => {
    observers = [];
    (globalThis as any).IntersectionObserver = class {
      private entry: { cb: (entries: any[]) => void; observed: Set<Element> };
      constructor(cb: (entries: any[]) => void) {
        this.entry = { cb, observed: new Set() };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.observed.add(el);
      }
      unobserve(el: Element) {
        this.entry.observed.delete(el);
      }
      disconnect() {
        this.entry.observed.clear();
      }
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 200 });
    document.body.innerHTML = '';
    loadWebview();
  });

  afterEach(() => {
    delete (globalThis as any).IntersectionObserver;
    if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
  });

  /** Scroll the bubble far away (detach), then back (reattach). */
  function scrollAwayAndBack(el: HTMLElement): void {
    const [detach, reattach] = observers;
    detach.cb([{ target: el, isIntersecting: false }]);
    expect(el.classList.contains('virtualized')).toBe(true);
    reattach.cb([{ target: el, isIntersecting: true }]);
    expect(el.classList.contains('virtualized')).toBe(false);
  }

  it('an answer comes back with Regenerate, not Edit, and keeps its plan buttons', () => {
    deliver({ command: 'setLoading', isLoading: true });
    deliver({ command: 'assistantMessage', content: '1. Edit the parser' });
    deliver({ command: 'planReady' });
    deliver({ command: 'done' });
    const plan = bubbles('.message.assistant:not(.typing-indicator)').pop()!;
    expect(plan.querySelector('.plan-execute')).not.toBeNull();

    scrollAwayAndBack(plan);

    expect(plan.textContent).toContain('Edit the parser');
    expect(plan.querySelector('.message-regen-btn')).not.toBeNull();
    expect(plan.querySelector('.message-edit-btn')).toBeNull();
    sent.length = 0;
    plan.querySelector<HTMLButtonElement>('.plan-execute')!.click();
    expect(sent).toEqual([{ command: 'executePlan' }]);
  });

  it('a prompt keeps its attachment label', () => {
    deliver({ command: 'fileAttached', fileName: 'a.ts', fileContent: 'const a = 1;' });
    type('why is a 1?');
    const prompt = bubbles('.message.user')[0];

    scrollAwayAndBack(prompt);

    expect(prompt.querySelector('.attachment-label')?.textContent).toBe('Attached: a.ts');
    expect(prompt.querySelector('.message-edit-btn')).not.toBeNull();
  });
});
