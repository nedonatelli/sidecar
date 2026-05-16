import { describe, it, expect, vi } from 'vitest';
import { notifyBgComplete, type BgNotifyDeps } from './bgNotifier.js';
import type { BackgroundAgentRunInfo } from './backgroundAgent.js';

function makeDeps(): {
  deps: BgNotifyDeps;
  showInfo: ReturnType<typeof vi.fn>;
  showErr: ReturnType<typeof vi.fn>;
  execCmd: ReturnType<typeof vi.fn>;
} {
  const showInfo = vi.fn().mockResolvedValue(undefined);
  const showErr = vi.fn().mockResolvedValue(undefined);
  const execCmd = vi.fn().mockResolvedValue(undefined);
  return {
    deps: { showInformationMessage: showInfo, showErrorMessage: showErr, executeCommand: execCmd },
    showInfo,
    showErr,
    execCmd,
  };
}

function makeRun(overrides: Partial<BackgroundAgentRunInfo> = {}): BackgroundAgentRunInfo {
  return {
    id: 'bg-1',
    task: 'fix the auth bug',
    status: 'completed',
    startedAt: Date.now(),
    output: 'done',
    toolCalls: 5,
    ...overrides,
  };
}

describe('notifyBgComplete', () => {
  it('shows an information message for completed runs', () => {
    const { deps, showInfo, showErr } = makeDeps();
    notifyBgComplete(makeRun({ status: 'completed', toolCalls: 3 }), deps);
    expect(showInfo).toHaveBeenCalledOnce();
    expect(showErr).not.toHaveBeenCalled();
    const [msg] = showInfo.mock.calls[0] as [string, ...string[]];
    expect(msg).toContain('completed');
    expect(msg).toContain('fix the auth bug');
    expect(msg).toContain('3 tool calls');
  });

  it('uses singular "1 tool call" when toolCalls is 1', () => {
    const { deps, showInfo } = makeDeps();
    notifyBgComplete(makeRun({ status: 'completed', toolCalls: 1 }), deps);
    const [msg] = showInfo.mock.calls[0] as [string, ...string[]];
    expect(msg).toContain('1 tool call');
    expect(msg).not.toContain('1 tool calls');
  });

  it('shows an error message for failed runs', () => {
    const { deps, showInfo, showErr } = makeDeps();
    notifyBgComplete(makeRun({ status: 'failed', error: 'OOM' }), deps);
    expect(showErr).toHaveBeenCalledOnce();
    expect(showInfo).not.toHaveBeenCalled();
    const [msg] = showErr.mock.calls[0] as [string, ...string[]];
    expect(msg).toContain('failed');
    expect(msg).toContain('OOM');
  });

  it('shows error message without error suffix when error field is absent', () => {
    const { deps, showErr } = makeDeps();
    notifyBgComplete(makeRun({ status: 'failed', error: undefined }), deps);
    const [msg] = showErr.mock.calls[0] as [string, ...string[]];
    expect(msg).toContain('failed');
    expect(msg).not.toContain('undefined');
  });

  it('is silent for cancelled runs', () => {
    const { deps, showInfo, showErr } = makeDeps();
    notifyBgComplete(makeRun({ status: 'cancelled' }), deps);
    expect(showInfo).not.toHaveBeenCalled();
    expect(showErr).not.toHaveBeenCalled();
  });

  it('truncates long task labels to 50 chars', () => {
    const { deps, showInfo } = makeDeps();
    const longTask = 'a'.repeat(80);
    notifyBgComplete(makeRun({ status: 'completed', task: longTask }), deps);
    const [msg] = showInfo.mock.calls[0] as [string, ...string[]];
    expect(msg).toContain('…');
    expect(msg).not.toContain(longTask);
  });

  it('includes "View Output" as the action for completed runs', () => {
    const { deps, showInfo } = makeDeps();
    notifyBgComplete(makeRun({ status: 'completed' }), deps);
    const args = showInfo.mock.calls[0] as string[];
    expect(args).toContain('View Output');
  });

  it('includes "View Output" as the action for failed runs', () => {
    const { deps, showErr } = makeDeps();
    notifyBgComplete(makeRun({ status: 'failed' }), deps);
    const args = showErr.mock.calls[0] as string[];
    expect(args).toContain('View Output');
  });

  it('executes the focus command when user clicks View Output on completed run', async () => {
    const { deps, showInfo, execCmd } = makeDeps();
    showInfo.mockResolvedValue('View Output');
    notifyBgComplete(makeRun({ status: 'completed' }), deps);
    await new Promise(process.nextTick);
    expect(execCmd).toHaveBeenCalledWith('sidecar.backgroundAgents.focus');
  });

  it('executes the focus command when user clicks View Output on failed run', async () => {
    const { deps, showErr, execCmd } = makeDeps();
    showErr.mockResolvedValue('View Output');
    notifyBgComplete(makeRun({ status: 'failed' }), deps);
    await new Promise(process.nextTick);
    expect(execCmd).toHaveBeenCalledWith('sidecar.backgroundAgents.focus');
  });

  it('does not execute focus command when user dismisses the toast', async () => {
    const { deps, showInfo, execCmd } = makeDeps();
    showInfo.mockResolvedValue(undefined);
    notifyBgComplete(makeRun({ status: 'completed' }), deps);
    await new Promise(process.nextTick);
    expect(execCmd).not.toHaveBeenCalled();
  });

  it('truncates a very long error message to 80 chars', () => {
    const { deps, showErr } = makeDeps();
    const longError = 'x'.repeat(200);
    notifyBgComplete(makeRun({ status: 'failed', error: longError }), deps);
    const [msg] = showErr.mock.calls[0] as [string, ...string[]];
    expect(msg.length).toBeLessThan(300);
    expect(msg).toContain('x'.repeat(80));
    expect(msg).not.toContain('x'.repeat(81));
  });
});
