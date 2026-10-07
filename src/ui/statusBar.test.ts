import { describe, it, expect, vi } from 'vitest';

// The shared vscode mock has no MarkdownString; record what the hover builds.
const built: Array<{ isTrusted: unknown; markdown: string; codeblocks: string[] }> = [];
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeMarkdownString {
    isTrusted: unknown = false;
    supportHtml = false;
    markdown = '';
    codeblocks: string[] = [];
    constructor() {
      built.push(this);
    }
    appendMarkdown(s: string) {
      this.markdown += s;
      return this;
    }
    appendCodeblock(code: string) {
      this.codeblocks.push(code);
      return this;
    }
  }
  return { ...actual, MarkdownString: FakeMarkdownString };
});

import { window, workspace, commands } from 'vscode';
import { registerStatusBar, HOVER_COMMANDS, escapeMarkdown, codeSpan } from './statusBar.js';
import { healthStatus } from '../ollama/healthStatus.js';

// Backend error text is a response body from whatever server baseUrl names.
// With blanket trust, a command: link planted in it ran when clicked.
describe('status bar hover', () => {
  it('trusts only its own commands and renders backend text as text', () => {
    vi.spyOn(window, 'createStatusBarItem').mockImplementation(() => ({ show() {}, hide() {}, dispose() {} }) as never);
    const ws = workspace as unknown as Record<string, unknown>;
    ws.onDidChangeConfiguration ??= () => ({ dispose() {} });
    const cmds = commands as unknown as Record<string, unknown>;
    cmds.registerCommand ??= () => ({ dispose() {} });
    registerStatusBar({ subscriptions: [] } as never, { getChatProvider: () => undefined });

    const planted = '[Re-authenticate](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22curl%22%7D)';
    healthStatus.setError(planted, '```\n[click me](command:workbench.action.terminal.sendSequence)\n```');

    const hover = built.at(-1)!;
    expect(hover.isTrusted).toEqual({ enabledCommands: HOVER_COMMANDS });
    // The planted link is escaped: no live `](command:workbench...` in the markdown.
    expect(hover.markdown).not.toMatch(/(^|[^\\])\]\(command:workbench/);
    // The full error goes through appendCodeblock, which fences it safely.
    expect(hover.codeblocks.join('')).toContain('[click me]');
    expect(hover.markdown).not.toContain('[click me]');
    healthStatus.reset();
  });

  it('escapes markdown and keeps code spans closed', () => {
    expect(escapeMarkdown('[x](command:y)')).toBe('\\[x\\]\\(command:y\\)');
    expect(codeSpan('a`[x](command:y)`b')).toBe("`a'[x](command:y)'b`");
  });
});

// A blank line in a workspace-set model name ended the code span; the markdown
// after it became a live, trusted command link in the hover.
describe('codeSpan keeps untrusted text on one line', () => {
  it('collapses newlines so nothing after them is parsed as markdown', () => {
    const out = codeSpan('qwen\n\n[click](command:sidecar.switchBackend?%22openrouter%22)');
    expect(out).not.toMatch(/\n/);
    expect(out.startsWith('`') && out.endsWith('`')).toBe(true);
  });
});
