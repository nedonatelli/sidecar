import { describe, it, expect } from 'vitest';
import { getChatWebviewHtml } from './chatWebview.js';

// Minimal mock matching what getChatWebviewHtml needs
const mockWebview = {
  cspSource: 'https://mock.csp.source',
  asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `vscode-webview://mock/${uri.fsPath}` }),
} as unknown as Parameters<typeof getChatWebviewHtml>[0];

const mockExtensionUri = { fsPath: '/mock/extension' } as unknown as Parameters<typeof getChatWebviewHtml>[1];

describe('getChatWebviewHtml', () => {
  const html = getChatWebviewHtml(mockWebview, mockExtensionUri);

  it('returns valid HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('includes CSP meta tag with script-src allowing cspSource', () => {
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('script-src');
    expect(html).toContain('https://mock.csp.source');
  });

  it('references external chat.css stylesheet', () => {
    expect(html).toMatch(/href="[^"]*chat\.css[^"]*"/);
  });

  it('references external chat.js script', () => {
    expect(html).toMatch(/src="[^"]*chat\.js[^"]*"/);
  });

  it('includes a nonce on the script tag', () => {
    expect(html).toMatch(/nonce="[A-Za-z0-9+/=]+"/);
  });

  it('does NOT contain inline JavaScript', () => {
    // The script tag should be self-contained (src=...) with no inline body
    expect(html).not.toContain('acquireVsCodeApi');
    expect(html).not.toContain('addEventListener');
    expect(html).not.toContain('function submitMessage');
  });

  it('contains expected DOM structure', () => {
    expect(html).toContain('id="messages"');
    expect(html).toContain('id="input"');
    expect(html).toContain('id="send"');
    expect(html).toContain('id="attach-btn"');
    expect(html).toContain('id="model-panel"');
  });

  it('file is under 200 lines (regression: no inline JS)', () => {
    const lineCount = html.split('\n').length;
    expect(lineCount).toBeLessThan(200);
  });
});
