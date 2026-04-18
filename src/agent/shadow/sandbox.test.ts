import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window } from 'vscode';

// Mock the ShadowWorkspace module at load-time because vi.spyOn can't
// replace a class constructor after the fact. Each test reconfigures
// the mock via `mockImplementation` on the default-exported constructor.
const shadowMockCtor = vi.fn();
vi.mock('./shadowWorkspace.js', () => ({
  ShadowWorkspace: function (this: unknown, ...args: unknown[]) {
    return shadowMockCtor(...args);
  },
}));

import * as settings from '../../config/settings.js';
import * as shared from '../tools/shared.js';
import * as loopModule from '../loop.js';
import { runAgentLoopInSandbox } from './sandbox.js';

// Tests cover the dispatch logic in sandbox.ts — when to shadow, when to
// go direct, and the accept/reject path at run's end. We mock
// `runAgentLoop` and `ShadowWorkspace` so we exercise the wrapper's
// branching without actually spawning git worktrees here (those are
// covered in shadowWorkspace.test.ts against real tmp repos).

type Callbacks = Parameters<typeof runAgentLoopInSandbox>[2];

describe('runAgentLoopInSandbox', () => {
  let textMessages: string[];
  let callbacks: Callbacks;

  beforeEach(() => {
    textMessages = [];
    callbacks = {
      onText: (t: string) => textMessages.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onDone: () => {},
    } as unknown as Callbacks;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    shadowMockCtor.mockReset();
  });

  describe('mode = off', () => {
    it('delegates straight to runAgentLoop without creating a shadow', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({ shadowWorkspaceMode: 'off' } as never);
      const loopSpy = vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(loopSpy).toHaveBeenCalledOnce();
      expect(shadowMockCtor).not.toHaveBeenCalled();
      expect(result.mode).toBe('direct');
      expect(result.applied).toBe(true);
    });
  });

  describe('mode = opt-in without forceShadow', () => {
    it('delegates straight to runAgentLoop without creating a shadow', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({ shadowWorkspaceMode: 'opt-in' } as never);
      const loopSpy = vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(loopSpy).toHaveBeenCalledOnce();
      expect(shadowMockCtor).not.toHaveBeenCalled();
      expect(result.mode).toBe('direct');
    });
  });

  describe('mode = always', () => {
    function stubShadow(overrides: Partial<{ diff: string; applyThrows: boolean }>) {
      const createMock = vi.fn().mockResolvedValue(undefined);
      const diffMock = vi.fn().mockResolvedValue(overrides.diff ?? '');
      const applyMock = overrides.applyThrows
        ? vi.fn().mockRejectedValue(new Error('conflict'))
        : vi.fn().mockResolvedValue('applied');
      const disposeMock = vi.fn().mockResolvedValue(undefined);
      const fakeShadow = {
        id: 'task-abcd1234',
        path: '/tmp/shadows/task-abcd1234',
        mainRoot: '/mock-workspace',
        create: createMock,
        diff: diffMock,
        applyToMain: applyMock,
        dispose: disposeMock,
        isActive: true,
      };
      shadowMockCtor.mockReturnValue(fakeShadow);
      return { createMock, diffMock, applyMock, disposeMock, fakeShadow };
    }

    it('falls through to direct when no workspace folder is open', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({ shadowWorkspaceMode: 'always' } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('');
      const loopSpy = vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(loopSpy).toHaveBeenCalledOnce();
      expect(result.mode).toBe('direct');
      expect(textMessages.join('')).toContain('shadow mode skipped');
    });

    it('creates a shadow, passes cwdOverride to runAgentLoop, and returns empty-diff when nothing changed', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const { fakeShadow, disposeMock } = stubShadow({ diff: '' });
      const loopSpy = vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);
      // QuickPick should NOT fire when diff is empty.
      const quickPickSpy = vi.spyOn(window, 'showQuickPick');

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      // Shadow created, loop called with cwdOverride pointing at shadow.path.
      expect(loopSpy).toHaveBeenCalledOnce();
      const optionsArg = loopSpy.mock.calls[0][4];
      expect(optionsArg?.cwdOverride).toBe(fakeShadow.path);

      expect(result.mode).toBe('shadow');
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('empty-diff');
      expect(result.shadowId).toBe(fakeShadow.id);
      expect(quickPickSpy).not.toHaveBeenCalled();
      expect(disposeMock).toHaveBeenCalledOnce();
    });

    it('prompts the user on non-empty diff and applies on accept', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const { applyMock, disposeMock } = stubShadow({ diff: 'diff --git a/foo b/foo\n+new line\n' });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);
      vi.spyOn(window, 'showQuickPick').mockResolvedValue({ value: 'accept' } as never);

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(applyMock).toHaveBeenCalledOnce();
      expect(disposeMock).toHaveBeenCalledOnce();
      expect(result.applied).toBe(true);
      expect(result.mode).toBe('shadow');
    });

    it('does NOT apply on reject and returns the rejected diff', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const { applyMock, disposeMock } = stubShadow({ diff: 'diff --git a/foo b/foo\n+nope\n' });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);
      vi.spyOn(window, 'showQuickPick').mockResolvedValue({ value: 'reject' } as never);

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(applyMock).not.toHaveBeenCalled();
      expect(disposeMock).toHaveBeenCalledOnce();
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('rejected');
      expect(result.rejectedDiff).toContain('+nope');
    });

    it('reports apply-failed when applyToMain throws (conflict) and preserves the diff', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      stubShadow({ diff: 'diff --git a/x b/x\n+x\n', applyThrows: true });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);
      vi.spyOn(window, 'showQuickPick').mockResolvedValue({ value: 'accept' } as never);

      const result = await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('apply-failed');
      expect(result.rejectedDiff).toContain('+x');
    });

    it('preserves the shadow when autoCleanup is false', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: false,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const { disposeMock } = stubShadow({ diff: '' });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);

      await runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {});

      expect(disposeMock).not.toHaveBeenCalled();
      expect(textMessages.join('')).toContain('shadow preserved');
    });

    it('still runs cleanup when the agent loop throws', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const { disposeMock } = stubShadow({ diff: '' });
      vi.spyOn(loopModule, 'runAgentLoop').mockRejectedValue(new Error('agent crashed'));

      await expect(runAgentLoopInSandbox({} as never, [], callbacks, new AbortController().signal, {})).rejects.toThrow(
        'agent crashed',
      );

      expect(disposeMock).toHaveBeenCalledOnce();
    });
  });

  describe('deferPrompt (v0.66 chunk 3.6)', () => {
    it('captures the diff as pendingDiff and skips the quickpick when set', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const createMock = vi.fn().mockResolvedValue(undefined);
      const diffMock = vi.fn().mockResolvedValue('diff --git a/x b/x\n+deferred\n');
      const applyMock = vi.fn().mockResolvedValue('applied');
      const disposeMock = vi.fn().mockResolvedValue(undefined);
      shadowMockCtor.mockReturnValue({
        id: 'task-deferred',
        path: '/tmp/shadows/task-deferred',
        create: createMock,
        diff: diffMock,
        applyToMain: applyMock,
        dispose: disposeMock,
        isActive: true,
      });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);
      const quickPickSpy = vi.spyOn(window, 'showQuickPick');

      const result = await runAgentLoopInSandbox(
        {} as never,
        [],
        callbacks,
        new AbortController().signal,
        {},
        { deferPrompt: true },
      );

      expect(quickPickSpy).not.toHaveBeenCalled();
      expect(applyMock).not.toHaveBeenCalled();
      expect(disposeMock).toHaveBeenCalledOnce();
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('deferred');
      expect(result.pendingDiff).toContain('+deferred');
      expect(result.shadowId).toBe('task-deferred');
    });

    it('still returns empty-diff without a pendingDiff when the facet made no writes', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'always',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const createMock = vi.fn().mockResolvedValue(undefined);
      const diffMock = vi.fn().mockResolvedValue('');
      const disposeMock = vi.fn().mockResolvedValue(undefined);
      shadowMockCtor.mockReturnValue({
        id: 'task-empty',
        path: '/tmp/shadows/task-empty',
        create: createMock,
        diff: diffMock,
        dispose: disposeMock,
        isActive: true,
      });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);

      const result = await runAgentLoopInSandbox(
        {} as never,
        [],
        callbacks,
        new AbortController().signal,
        {},
        { deferPrompt: true },
      );

      expect(result.reason).toBe('empty-diff');
      expect(result.pendingDiff).toBeUndefined();
    });
  });

  describe('forceShadow in opt-in mode', () => {
    it('wraps when sandboxOptions.forceShadow is true', async () => {
      vi.spyOn(settings, 'getConfig').mockReturnValue({
        shadowWorkspaceMode: 'opt-in',
        shadowWorkspaceAutoCleanup: true,
      } as never);
      vi.spyOn(shared, 'getRoot').mockReturnValue('/mock-workspace');
      const createMock = vi.fn().mockResolvedValue(undefined);
      const diffMock = vi.fn().mockResolvedValue('');
      const disposeMock = vi.fn().mockResolvedValue(undefined);
      shadowMockCtor.mockReturnValue({
        id: 'task-forced',
        path: '/tmp/shadows/task-forced',
        create: createMock,
        diff: diffMock,
        dispose: disposeMock,
        isActive: true,
      });
      vi.spyOn(loopModule, 'runAgentLoop').mockResolvedValue([] as never);

      const result = await runAgentLoopInSandbox(
        {} as never,
        [],
        callbacks,
        new AbortController().signal,
        {},
        { forceShadow: true },
      );

      expect(createMock).toHaveBeenCalledOnce();
      expect(result.mode).toBe('shadow');
    });
  });
});
