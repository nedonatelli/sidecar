import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveRequestContent, buildHistoryFromChatContext } from './sidecarParticipant.js';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// resolveRequestContent
// ---------------------------------------------------------------------------

describe('resolveRequestContent', () => {
  beforeEach(() => {
    vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
      getText: (_range?: unknown) => 'function foo() {}',
      uri: { fsPath: '/file.ts', scheme: 'file', path: '/file.ts' },
    } as ReturnType<typeof vscode.workspace.openTextDocument> extends Promise<infer T> ? T : never);
  });

  it('uses generic system prompt when no command', async () => {
    const { systemPrompt } = await resolveRequestContent({
      prompt: 'hello',
      command: undefined,
      references: [],
    } as unknown as import('vscode').ChatRequest);
    expect(systemPrompt).toContain('SideCar');
    expect(systemPrompt).not.toContain('reviewer');
  });

  it('uses review system prompt for /review command', async () => {
    const { systemPrompt, userText } = await resolveRequestContent({
      prompt: 'is this ok?',
      command: 'review',
      references: [],
    } as unknown as import('vscode').ChatRequest);
    expect(systemPrompt).toContain('reviewer');
    expect(userText).toContain('is this ok?');
  });

  it('uses commit-message system prompt for /commit-message command', async () => {
    const { systemPrompt } = await resolveRequestContent({
      prompt: '',
      command: 'commit-message',
      references: [],
    } as unknown as import('vscode').ChatRequest);
    expect(systemPrompt).toContain('conventional-commits');
  });

  it('falls back to generic prompt for unknown slash command', async () => {
    const { systemPrompt } = await resolveRequestContent({
      prompt: 'hello',
      command: 'unknown-command',
      references: [],
    } as unknown as import('vscode').ChatRequest);
    expect(systemPrompt).toContain('SideCar');
    expect(systemPrompt).not.toContain('reviewer');
  });

  it('inlines Uri reference text into userText', async () => {
    const uri = vscode.Uri.file('/file.ts');
    const { userText } = await resolveRequestContent({
      prompt: 'explain this',
      command: undefined,
      references: [{ id: 'file', name: 'file.ts', value: uri }],
    } as unknown as import('vscode').ChatRequest);
    expect(userText).toContain('function foo()');
    expect(userText).toContain('explain this');
  });

  it('inlines string reference directly', async () => {
    const { userText } = await resolveRequestContent({
      prompt: 'context:',
      command: undefined,
      references: [{ id: 'str', name: 'note', value: 'extra context here' }],
    } as unknown as import('vscode').ChatRequest);
    expect(userText).toContain('extra context here');
  });

  it('returns prompt as-is when no references', async () => {
    const { userText } = await resolveRequestContent({
      prompt: 'what is a closure?',
      command: undefined,
      references: [],
    } as unknown as import('vscode').ChatRequest);
    expect(userText).toBe('what is a closure?');
  });
});

// ---------------------------------------------------------------------------
// buildHistoryFromChatContext
// ---------------------------------------------------------------------------

describe('buildHistoryFromChatContext', () => {
  it('converts request turns to user messages', () => {
    const history = [{ prompt: 'first question' }];
    const msgs = buildHistoryFromChatContext(history as never, 'current question');
    expect(msgs[0]).toEqual({ role: 'user', content: 'first question' });
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'current question' });
  });

  it('converts response turns to assistant messages', () => {
    const history = [{ prompt: 'hi' }, { response: [{ value: 'hello!' }] }];
    const msgs = buildHistoryFromChatContext(history as never, 'follow-up');
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'hello!' });
  });

  it('concatenates multiple response parts', () => {
    const history = [{ prompt: 'q' }, { response: [{ value: 'part1 ' }, { value: 'part2' }] }];
    const msgs = buildHistoryFromChatContext(history as never, 'next');
    expect(msgs[1].content).toBe('part1 part2');
  });

  it('caps history at maxTurns pairs', () => {
    const history = Array.from({ length: 60 }, (_, i) => ({ prompt: `q${i}` }));
    const msgs = buildHistoryFromChatContext(history as never, 'current', 20);
    // 20 maxTurns * 2 = 40 entries capped, plus current = 41 messages
    expect(msgs.length).toBeLessThanOrEqual(41);
  });

  it('always appends current user text as last message', () => {
    const msgs = buildHistoryFromChatContext([], 'my question');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'my question' });
  });
});
