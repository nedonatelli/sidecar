// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// A link in a reply was an <a href>, which VS Code opens itself when clicked,
// so the extension's check on where a link goes never ran. Links now post
// openExternal, and mermaid renders in strict mode.

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

describe('links in a reply', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
  });

  it('are not anchors, so a click cannot open them without the extension', () => {
    deliver({ command: 'init', messages: [{ role: 'assistant', content: 'See [the docs](https://evil.example/x).' }] });
    expect(messagesEl.querySelector('a[href]')).toBeNull();
    const link = messagesEl.querySelector<HTMLElement>('.md-link')!;
    expect(link.textContent).toBe('the docs');
    expect(link.title).toBe('https://evil.example/x');
  });

  it('post openExternal with the URL when clicked or activated with Enter', () => {
    deliver({ command: 'init', messages: [{ role: 'assistant', content: '[x](https://github.com/a/b)' }] });
    const link = messagesEl.querySelector<HTMLElement>('.md-link')!;
    link.click();
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.filter((m) => m.command === 'openExternal')).toEqual([
      { command: 'openExternal', url: 'https://github.com/a/b' },
      { command: 'openExternal', url: 'https://github.com/a/b' },
    ]);
  });
});

describe('mermaid', () => {
  it('is initialized in strict mode', () => {
    expect(CHAT_JS).toContain("const MERMAID_SECURITY = 'strict';");
    expect(CHAT_JS).not.toContain("securityLevel: 'loose'");
  });
});
