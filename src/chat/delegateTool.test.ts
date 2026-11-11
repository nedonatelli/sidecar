/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { readFileSync } from 'fs';

// sidecar_delegate (#493) carries @sidecar into the Copilot harness, which
// runs extension tools but not chat participants.

const handlers = vi.hoisted(() => new Map<string, any>());
const ROOT = vi.hoisted(() => (process.platform === 'win32' ? 'C:\\ws' : '/ws'));
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    lm: {
      registerTool: (name: string, h: unknown) => {
        handlers.set(name, h);
        return { dispose() {} };
      },
    },
    LanguageModelTextPart: class {
      constructor(public value: string) {}
    },
    LanguageModelToolResult: class {
      constructor(public content: Array<{ value: string }>) {}
    },
    workspace: {
      ...actual.workspace,
      openTextDocument: async (uri: { fsPath: string }) => ({
        getText: () => `contents of ${path.basename(uri.fsPath)}`,
      }),
    },
  };
});
vi.mock('../agent/loop.js', () => ({ runAgentLoop: vi.fn(async () => undefined) }));
vi.mock('../config/workspace.js', () => ({ getWorkspaceRoot: () => ROOT }));
const config = vi.hoisted(() => ({ agentMode: 'cautious', customModes: [] as unknown[], model: 'qwen3-coder:30b' }));
vi.mock('../config/settings.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getConfig: () => config };
});

import { runAgentLoop } from '../agent/loop.js';
import { buildDelegateMessage, registerDelegateTool, resolveAttachment, DELEGATE_TOOL_NAME } from './delegateTool.js';
import { GENERIC_SYSTEM_PROMPT, SLASH_COMMANDS } from './sidecarParticipant.js';

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

function fakeClient(text = '') {
  return {
    updateSystemPrompt: vi.fn(),
    streamChat: vi.fn(async function* () {
      yield { type: 'text', text };
      yield { type: 'stop' };
    }),
  };
}

function register(client: ReturnType<typeof fakeClient>) {
  registerDelegateTool({ subscriptions: [] } as never, () => client as never);
  return handlers.get(DELEGATE_TOOL_NAME);
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(runAgentLoop).mockReset();
});

describe('sidecar_delegate agent mode', () => {
  it("runs SideCar's loop under the user's approval mode and returns its text and changed files", async () => {
    vi.mocked(runAgentLoop).mockImplementation((async (_c: unknown, _m: unknown, callbacks: any) => {
      callbacks.onToolCall('edit_file', { path: 'src/a.ts' }, 't1');
      callbacks.onText('Fixed the off-by-one.');
    }) as never);
    const tool = register(fakeClient());

    const result = await tool.invoke({ input: { task: 'fix the loop bound in src/a.ts' } }, token);

    const [, messages, , , options] = vi.mocked(runAgentLoop).mock.calls[0] as any[];
    expect(messages).toEqual([{ role: 'user', content: 'fix the loop bound in src/a.ts' }]);
    expect(options.approvalMode).toBe('cautious');
    expect(typeof options.confirmFn).toBe('function');
    expect(options.systemPromptOverride).toBe(GENERIC_SYSTEM_PROMPT);
    expect(result.content[0].value).toBe(`Fixed the off-by-one.\n\nFiles changed:\n- ${path.join('src', 'a.ts')}`);
  });

  it('says so when the run is cancelled', async () => {
    vi.mocked(runAgentLoop).mockImplementation((async (_c: unknown, _m: unknown, callbacks: any) => {
      callbacks.onText('Started.');
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as never);
    const result = await register(fakeClient()).invoke({ input: { task: 'x' } }, token);
    expect(result.content[0].value).toBe('Started.\n\n[SideCar run cancelled]');
  });

  it('passes other errors to VS Code', async () => {
    vi.mocked(runAgentLoop).mockRejectedValue(new Error('backend unreachable'));
    await expect(register(fakeClient()).invoke({ input: { task: 'x' } }, token)).rejects.toThrow('backend unreachable');
  });
});

describe('sidecar_delegate answer modes', () => {
  it('give one completion under the mode prompt, passed per call so the panel prompt is untouched', async () => {
    const client = fakeClient('Looks fine.');
    const result = await register(client).invoke({ input: { task: 'const x = 1;', mode: 'review' } }, token);

    expect(runAgentLoop).not.toHaveBeenCalled();
    expect(client.updateSystemPrompt).not.toHaveBeenCalled();
    const call = client.streamChat.mock.calls[0] as any[];
    expect(call[0]).toEqual([{ role: 'user', content: SLASH_COMMANDS.review.preamble('const x = 1;') }]);
    expect(call[3]).toBe(SLASH_COMMANDS.review.systemPrompt);
    expect(result.content[0].value).toBe('Looks fine.');
  });

  it('reject an unknown mode', async () => {
    await expect(register(fakeClient()).invoke({ input: { task: 'x', mode: 'deploy' } }, token)).rejects.toThrow(
      /Unknown mode "deploy"/,
    );
  });
});

describe('sidecar_delegate attachments', () => {
  it('stay inside the workspace', () => {
    expect(resolveAttachment(ROOT, 'src/a.ts')).toBe(path.join(ROOT, 'src', 'a.ts'));
    expect(resolveAttachment(ROOT, '../secrets.env')).toBeUndefined();
    expect(resolveAttachment(ROOT, path.resolve(ROOT, '..', 'other', 'b.ts'))).toBeUndefined();
    expect(resolveAttachment(ROOT, '.')).toBeUndefined();
  });

  it('are inlined, and a refused one is named without its contents', async () => {
    const text = await buildDelegateMessage(
      { task: 'explain', mode: 'explain', files: ['src/a.ts', '../x.env'] },
      ROOT,
    );
    expect(text).toBe(
      `${SLASH_COMMANDS.explain.preamble('explain')}\n\n` +
        '`src/a.ts`:\n```\ncontents of a.ts\n```\n\n' +
        '`../x.env`: not attached (outside the workspace)',
    );
  });
});

describe('sidecar_delegate confirmation', () => {
  it('names the model and the mode it will run under', () => {
    const prep = register(fakeClient()).prepareInvocation({ input: { task: 'refactor the parser' } });
    expect(prep.confirmationMessages.message).toContain('`qwen3-coder:30b`');
    expect(prep.confirmationMessages.message).toContain('`cautious` mode');
    expect(prep.confirmationMessages.message).toContain('> refactor the parser');
  });
});

describe('sidecar_delegate contribution', () => {
  it('is declared in package.json with a schema matching the modes', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const entry = pkg.contributes.languageModelTools.find((t: { name: string }) => t.name === DELEGATE_TOOL_NAME);
    expect(entry.inputSchema.required).toEqual(['task']);
    expect(entry.inputSchema.properties.mode.enum).toEqual(['agent', ...Object.keys(SLASH_COMMANDS)]);
  });
});
