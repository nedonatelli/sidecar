// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// The header's Thinking switch. The extension owns the value
// (`sidecar.ollama.disableThinking`) and sends `thinkingState`; the webview
// shows the switch only for Ollama and posts `setThinking` when it is pressed.

const CHAT_JS = readFileSync(resolve(process.cwd(), 'media/chat.js'), 'utf8');
// The real markup, so the test fails if the button's accessible attributes go.
const BUTTON_HTML = /<button id="thinking-btn"[\s\S]*?<\/button>/.exec(
  readFileSync(resolve(process.cwd(), 'src/webview/chatWebview.ts'), 'utf8'),
)![0];

let posted: any[];
let btn: HTMLButtonElement;

function loadWebview(): void {
  document.body.innerHTML = `<div id="chat-actions">${BUTTON_HTML}</div>`;
  const realById = document.getElementById.bind(document);
  const byId = new Map<string, HTMLElement>();
  document.getElementById = ((id: string): HTMLElement => {
    const real = realById(id);
    if (real) return real;
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
  posted = [];
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => posted.push(m),
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
  btn = document.getElementById('thinking-btn') as HTMLButtonElement;
}

function deliver(data: unknown): void {
  const event = new Event('message') as Event & { data: unknown };
  event.data = data;
  window.dispatchEvent(event);
}

const shown = () => !btn.classList.contains('hidden');
const pressed = () => btn.getAttribute('aria-pressed');

describe('header Thinking switch', () => {
  beforeEach(loadWebview);

  it('is a real, labelled toggle button with a tooltip', () => {
    // A native <button>: focusable, and Enter/Space fire the click handler.
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('Thinking');
    expect(btn.hasAttribute('aria-pressed')).toBe(true);
    expect(btn.getAttribute('data-tooltip')).toBe('Let the model think before answering (Ollama)');
  });

  it('stays hidden until the extension says the backend is Ollama', () => {
    expect(shown()).toBe(false);
    deliver({ command: 'thinkingState', thinkingSupported: false, thinkingEnabled: true });
    expect(shown()).toBe(false);
    deliver({ command: 'thinkingState', thinkingSupported: true, thinkingEnabled: true });
    expect(shown()).toBe(true);
  });

  it('hides again when the user switches to a backend that is not Ollama', () => {
    deliver({ command: 'thinkingState', thinkingSupported: true, thinkingEnabled: true });
    deliver({ command: 'thinkingState', thinkingSupported: false, thinkingEnabled: true });
    expect(shown()).toBe(false);
  });

  it('reflects the setting, including a change made elsewhere', () => {
    deliver({ command: 'thinkingState', thinkingSupported: true, thinkingEnabled: true });
    expect(pressed()).toBe('true');
    // e.g. the settings UI, or another window, set disableThinking: true
    deliver({ command: 'thinkingState', thinkingSupported: true, thinkingEnabled: false });
    expect(pressed()).toBe('false');
  });

  it('a press flips the switch and asks the extension to write the setting', () => {
    deliver({ command: 'thinkingState', thinkingSupported: true, thinkingEnabled: true });
    btn.click();
    expect(pressed()).toBe('false');
    expect(posted).toContainEqual({ command: 'setThinking', thinkingEnabled: false });
    btn.click();
    expect(pressed()).toBe('true');
    expect(posted.at(-1)).toEqual({ command: 'setThinking', thinkingEnabled: true });
  });
});
