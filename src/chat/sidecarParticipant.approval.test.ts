import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../agent/loop.js', () => ({ runAgentLoop: vi.fn(async () => undefined) }));
const config = vi.hoisted(() => ({ agentMode: 'cautious', customModes: [] as unknown[] }));
vi.mock('../config/settings.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getConfig: () => config };
});

import { runAgentLoop } from '../agent/loop.js';
import { participantApprovalOptions, registerSidecarParticipant } from './sidecarParticipant.js';

// @sidecar runs SideCar's own loop, so VS Code's chat tool approval never sees
// its tool calls. It used to run every request as 'autonomous' -- a user in
// cautious mode got no prompt before writes or commands.

describe('participantApprovalOptions', () => {
  it.each([
    ['cautious', 'cautious'],
    ['manual', 'manual'],
    ['autonomous', 'autonomous'],
    ['plan', 'cautious'], // needs the SideCar panel's plan view
    ['review', 'cautious'], // needs the panel's pending-edit queue
  ])('agentMode %s runs as %s', (mode, expected) => {
    expect(participantApprovalOptions({ agentMode: mode, customModes: [] }).approvalMode).toBe(expected);
  });

  it('asks through a modal and returns the chosen action', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Allow' as never);
    const { confirmFn } = participantApprovalOptions({ agentMode: 'cautious', customModes: [] });
    expect(await confirmFn('Run **`rm -rf build`**?', ['Allow', 'Deny'])).toBe('Allow');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rm -rf build'), { modal: true }, 'Allow', 'Deny');
  });
});

describe('@sidecar agent requests', () => {
  beforeEach(() => vi.mocked(runAgentLoop).mockClear());

  it("run under the user's approval mode with a working confirm, not 'autonomous'", async () => {
    let handler: vscode.ChatRequestHandler | undefined;
    vi.spyOn(vscode.chat, 'createChatParticipant').mockImplementation(((_id: string, h: vscode.ChatRequestHandler) => {
      handler = h;
      return { iconPath: undefined, dispose() {} };
    }) as never);
    registerSidecarParticipant({ subscriptions: [] } as never, () => ({}) as never);

    config.agentMode = 'cautious';
    const response = { markdown() {}, progress() {}, anchor() {}, button() {} };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    await handler!(
      { prompt: 'delete the build folder', command: undefined, references: [] } as never,
      { history: [] } as never,
      response as never,
      token as never,
    );

    const options = vi.mocked(runAgentLoop).mock.calls[0][4] as Record<string, unknown>;
    expect(options.approvalMode).toBe('cautious');
    expect(typeof options.confirmFn).toBe('function');
  });
});
