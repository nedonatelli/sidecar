// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { ArenaPanel } from './arenaPanel.js';
import { sanitizeEloState } from './eloStore.js';

// elo.json sits in the workspace's .sidecar/, so a cloned repo can ship one.
// Its values reach the Arena webview, whose script can start an autonomous
// agent run -- nothing from that file may become markup or script.

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';

function renderPanelHtml(): string {
  let html = '';
  const panel = {
    webview: {
      set html(v: string) {
        html = v;
      },
      get html() {
        return html;
      },
      cspSource: 'csp',
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async () => true,
    },
    reveal() {},
    dispose() {},
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeViewState: () => ({ dispose() {} }),
  };
  vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panel as never);
  const elo = { getRating: () => 1200, getRatings: () => ({}), getState: () => sanitizeEloState({}) };
  ArenaPanel.create({ subscriptions: [] } as never, {} as never, elo as never, ['m'], (() => {}) as never);
  (ArenaPanel as unknown as { current?: { dispose?: () => void } }).current?.dispose?.();
  return html;
}

describe('Arena: workspace-sourced ratings', () => {
  it('the store keeps only numbers from elo.json', () => {
    const state = sanitizeEloState({
      ratings: { good: 1234, bad: PAYLOAD, nan: Number.NaN },
      wins: { good: 3, bad: PAYLOAD, neg: -1 },
      losses: 'not an object',
      totalMatches: PAYLOAD,
    });
    expect(state).toEqual({ ratings: { good: 1234 }, wins: { good: 3 }, losses: {}, totalMatches: 0 });
  });

  it('the panel ships a nonce CSP and no inline event handlers', () => {
    const html = renderPanelHtml();
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toMatch(/\son(click|load|error|change|input|keydown)=/i);
  });

  it('a hostile rating posted to the webview renders as text, never as markup', async () => {
    const html = renderPanelHtml();
    const script = /<script(?: nonce="[0-9a-f]+")?>([\s\S]*?)<\/script>/.exec(html)![1];
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*<\/script>/, '');
    (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage() {},
      getState() {},
      setState() {},
    });
    // eslint-disable-next-line no-new-func
    new Function(script)();

    const event = new Event('message') as Event & { data: unknown };
    event.data = {
      command: 'init',
      models: ['m'],
      ratings: { m: PAYLOAD, [PAYLOAD]: 1500 },
      stats: { wins: { m: PAYLOAD }, losses: {}, totalMatches: 1 },
    };
    window.dispatchEvent(event);

    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
