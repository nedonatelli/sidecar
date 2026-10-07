// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// A fenced block whose info string names a file used to make the webview post
// `createFile` on render -- live, and again on every history replay -- so model
// output wrote to the workspace with no user action. Creating the file now
// takes a click on the block's "Create file" button.

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');
const NL = String.fromCharCode(10);
const FENCE = '`'.repeat(3);

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

const assistant = (info: string, body: string) => ['Here it is:', FENCE + info, body, FENCE].join(NL);

describe('code fences that name a file', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    loadWebview();
  });

  it('a restored message posts no createFile, and offers a Create file button', () => {
    deliver({
      command: 'init',
      messages: [{ role: 'assistant', content: assistant('sh:.git/hooks/pre-commit', '#!/bin/sh' + NL + 'echo hi') }],
    });
    expect(sent.filter((m) => m.command === 'createFile')).toEqual([]);
    const btn = messagesEl.querySelector<HTMLButtonElement>('[data-action="create"]');
    expect(btn?.dataset.path).toBe('.git/hooks/pre-commit');
    expect(messagesEl.textContent).toContain('echo hi'); // the code is shown, not hidden
  });

  it('clicking Create file posts createFile with that path and code', () => {
    deliver({ command: 'init', messages: [{ role: 'assistant', content: assistant('ts src/x.ts', 'export {};') }] });
    messagesEl.querySelector<HTMLButtonElement>('[data-action="create"]')!.click();
    const creates = sent.filter((m) => m.command === 'createFile');
    expect(creates).toEqual([{ command: 'createFile', code: 'export {};' + NL, filePath: 'src/x.ts' }]);
  });

  it.each(['c#', 'c++', 'js {1,3}'])('%s is a language tag, not a path', (info) => {
    deliver({ command: 'init', messages: [{ role: 'assistant', content: assistant(info, 'int x;') }] });
    expect(messagesEl.querySelector('[data-action="create"]')).toBeNull();
  });
});
