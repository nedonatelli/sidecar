// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// A reply is split at its code fences before the markdown is rendered, so a
// numbered list with a code block in an item became one <ol> per segment, each
// restarting at 1: "1. Item one", code, "1. Item two".

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');
const NL = String.fromCharCode(10);
const FENCE = '`'.repeat(3);

let messagesEl: HTMLElement;

function loadWebview(): void {
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
    postMessage: () => undefined,
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

function render(content: string): void {
  deliver({ command: 'init', messages: [{ role: 'assistant', content }] });
}

/** The number each list item shows, in order. */
function shownNumbers(): number[] {
  const out: number[] = [];
  for (const ol of messagesEl.querySelectorAll('ol')) {
    const start = Number(ol.getAttribute('start') ?? 1);
    [...ol.children].forEach((_, i) => out.push(start + i));
  }
  return out;
}

const code = (body: string) => [FENCE + 'sh', body, FENCE].join(NL);

describe('numbered lists in a reply', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
  });

  it('keep counting across a code block in an item', () => {
    render(['1. Install it:', code('npm i x'), '2. Run it:', code('npx x'), '3. Done.'].join(NL));
    expect(shownNumbers()).toEqual([1, 2, 3]);
  });

  it('keep counting when every item is written "1."', () => {
    render(['1. Install it:', code('npm i x'), '1. Run it:', code('npx x')].join(NL));
    expect(shownNumbers()).toEqual([1, 2]);
  });

  it('start at the number the list starts at', () => {
    render(['Continuing:', '', '4. Four', '5. Five'].join(NL));
    expect(shownNumbers()).toEqual([4, 5]);
  });

  it('restart for a new list after a code block followed by text', () => {
    render(['1. One', '2. Two', code('x'), 'Then, separately:', '', '1. Uno'].join(NL));
    expect(shownNumbers()).toEqual([1, 2, 1]);
  });

  it('keep counting while the reply streams in, written "1." throughout', () => {
    vi.useFakeTimers();
    try {
      deliver({ command: 'setLoading', isLoading: true });
      for (const chunk of [
        '1. Install it:' + NL,
        code('npm i x') + NL,
        '1. Run it:' + NL,
        code('npx x') + NL,
        '1. Done.',
      ]) {
        deliver({ command: 'assistantMessage', content: chunk });
        vi.advanceTimersByTime(200);
      }
      deliver({ command: 'done' });
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    expect(shownNumbers()).toEqual([1, 2, 3]);
  });

  it('count up when every item is written "1." with no code between', () => {
    render(['1. a', '1. b', '1. c'].join(NL));
    expect(shownNumbers()).toEqual([1, 2, 3]);
  });
});
