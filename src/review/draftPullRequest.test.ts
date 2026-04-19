import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process BEFORE importing the module under test so the
// `git symbolic-ref` resolver + the diffSource `git diff` calls both
// hit the mock. The diffSource primitive uses `exec` too (chunk 1),
// so one mock covers both.
vi.mock('child_process', () => ({ exec: vi.fn() }));
import { exec } from 'child_process';

import { runDraftPullRequest, type DraftPrConfig, type DraftPrUi, type DraftPrDeps } from './draftPullRequest.js';
import type { SideCarClient } from '../ollama/client.js';
import type { GitCLI } from '../github/git.js';
import type { GitHubAPI } from '../github/api.js';
import type { GitHubPR } from '../github/types.js';

// ---------------------------------------------------------------------------
// Tests for draftPullRequest.ts (v0.68 chunk 2).
//
// Every external seam is injected (ui, git, api) so the tests drive
// the end-to-end flow headlessly. child_process exec is still mocked
// for the `git symbolic-ref` path the resolver uses + for diffSource's
// underlying `git diff` call.
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function installExec(outputs: Record<string, string>, fail: Set<string> = new Set()): void {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, _opts: unknown, cb?: ExecCallback) => {
    const callback = typeof _opts === 'function' ? (_opts as ExecCallback) : cb;
    for (const key of Object.keys(outputs)) {
      if (cmd.startsWith(key)) {
        if (fail.has(key)) {
          callback?.(new Error(`simulated failure for ${key}`), { stdout: '', stderr: 'fatal' });
          return;
        }
        callback?.(null, { stdout: outputs[key], stderr: '' });
        return;
      }
    }
    callback?.(new Error(`unexpected exec: ${cmd}`), { stdout: '', stderr: '' });
  });
}

function makeFakeUi(): DraftPrUi & {
  confirmResponses: string[];
  inputResponses: (string | undefined)[];
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    showInputBox: [],
    showConfirm: [],
    showInfo: [],
    showError: [],
    openPreview: [],
  };
  const ui: DraftPrUi & {
    confirmResponses: string[];
    inputResponses: (string | undefined)[];
    calls: Record<string, unknown[]>;
  } = {
    calls,
    confirmResponses: [],
    inputResponses: [],
    async showInputBox(prompt, value) {
      calls.showInputBox.push({ prompt, value });
      return ui.inputResponses.shift();
    },
    async showConfirm(message, options) {
      calls.showConfirm.push({ message, options });
      return ui.confirmResponses.shift();
    },
    showInfo(message) {
      calls.showInfo.push(message);
    },
    showError(message) {
      calls.showError.push(message);
    },
    async openPreview(content, title) {
      calls.openPreview.push({ content, title });
    },
  };
  return ui;
}

interface GitStub {
  getCurrentBranch: ReturnType<typeof vi.fn>;
  getRemoteUrl: ReturnType<typeof vi.fn>;
  pushWithUpstream: ReturnType<typeof vi.fn>;
}

function makeGitStub(overrides: Partial<GitStub> = {}): GitStub {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue('feature/foo'),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
    pushWithUpstream: vi.fn().mockResolvedValue('Pushed'),
    ...overrides,
  };
}

function makeApiStub(pr: Partial<GitHubPR> = {}, protection: unknown = null): GitHubAPI {
  return {
    createPR: vi.fn().mockResolvedValue({
      number: 42,
      title: 't',
      state: 'open',
      author: 'me',
      url: 'https://github.com/owner/repo/pull/42',
      createdAt: '2026-04-18',
      ...pr,
    }),
    // Default: branch is unprotected. Tests that care about protection
    // pass an explicit `BranchProtection` object as the second arg.
    getBranchProtection: vi.fn().mockResolvedValue(protection),
  } as unknown as GitHubAPI;
}

function makeClientStub(summary = 'Add awesome feature\n\n## Summary\n- thing happened'): SideCarClient {
  return {
    updateSystemPrompt: vi.fn(),
    complete: vi.fn().mockResolvedValue(summary),
  } as unknown as SideCarClient;
}

function makeConfig(overrides: Partial<DraftPrConfig> = {}): DraftPrConfig {
  return {
    draftByDefault: true,
    baseBranch: 'auto',
    template: 'ignore',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DraftPrDeps> = {}): DraftPrDeps {
  return {
    ui: makeFakeUi(),
    client: makeClientStub(),
    cwd: '/ws',
    config: makeConfig(),
    git: makeGitStub() as unknown as GitCLI,
    api: makeApiStub(),
    ...overrides,
  };
}

beforeEach(() => {
  (exec as unknown as ReturnType<typeof vi.fn>).mockReset();
  // Default exec returns: origin/HEAD resolves to main, branch-range diff is non-empty.
  installExec({
    'git symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/main\n',
    'git diff main...HEAD': 'diff --git a/src/x.ts b/src/x.ts\n+feature change\n',
  });
});

describe('runDraftPullRequest — bailout paths', () => {
  it('errors out on detached HEAD (empty current branch)', async () => {
    const git = makeGitStub({ getCurrentBranch: vi.fn().mockResolvedValue('') });
    const deps = makeDeps({ git: git as unknown as GitCLI });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('cancelled');
    if (out.mode === 'cancelled') expect(out.reason).toBe('detached-head');
    expect((deps.ui as unknown as { calls: { showError: unknown[] } }).calls.showError).toHaveLength(1);
  });

  it('errors out when the current branch equals the base branch', async () => {
    const git = makeGitStub({ getCurrentBranch: vi.fn().mockResolvedValue('main') });
    const deps = makeDeps({ git: git as unknown as GitCLI });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('cancelled');
    if (out.mode === 'cancelled') expect(out.reason).toBe('on-base-branch');
  });

  it('errors out when origin remote is missing', async () => {
    const git = makeGitStub({ getRemoteUrl: vi.fn().mockResolvedValue(null) });
    const deps = makeDeps({ git: git as unknown as GitCLI });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('no-remote');
  });

  it('errors out when origin is not a GitHub URL', async () => {
    const git = makeGitStub({
      getRemoteUrl: vi.fn().mockResolvedValue('git@bitbucket.org:foo/bar.git'),
    });
    const deps = makeDeps({ git: git as unknown as GitCLI });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('no-remote');
  });

  it('surfaces no-changes when the branch range is empty', async () => {
    installExec({
      'git symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/main\n',
      'git diff main...HEAD': '', // empty range
    });
    const deps = makeDeps();
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('no-changes');
  });
});

describe('runDraftPullRequest — base branch resolution', () => {
  it('auto-resolves the base branch from origin/HEAD', async () => {
    installExec({
      'git symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n',
      'git diff develop...HEAD': 'diff --git a/x b/x\n+changed\n',
    });
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const deps = makeDeps({ ui });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('created');
    // The prompt text should reference develop as base.
    const confirmCall = ui.calls.showConfirm[0] as { message: string };
    expect(confirmCall.message).toMatch(/→ develop/);
  });

  it('falls back to "main" when origin/HEAD is unresolvable', async () => {
    installExec(
      {
        'git symbolic-ref refs/remotes/origin/HEAD': '',
        'git diff main...HEAD': 'diff --git a/x b/x\n+c\n',
      },
      new Set(['git symbolic-ref refs/remotes/origin/HEAD']),
    );
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const deps = makeDeps({ ui });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('created');
  });

  it('uses the explicit config baseBranch when provided', async () => {
    installExec({
      'git symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/main\n',
      'git diff release/v5...HEAD': 'diff --git a/x b/x\n+c\n',
    });
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const deps = makeDeps({ ui, config: makeConfig({ baseBranch: 'release/v5' }) });
    const out = await runDraftPullRequest(deps);
    expect(out.mode).toBe('created');
    const confirmCall = ui.calls.showConfirm[0] as { message: string };
    expect(confirmCall.message).toMatch(/→ release\/v5/);
  });
});

describe('runDraftPullRequest — happy path + confirm loop', () => {
  it('submits successfully when user confirms — calls pushWithUpstream then api.createPR', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const git = makeGitStub();
    const api = makeApiStub({ number: 123, url: 'https://github.com/owner/repo/pull/123' });
    const deps = makeDeps({ ui, git: git as unknown as GitCLI, api });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('created');
    if (out.mode === 'created') {
      expect(out.prNumber).toBe(123);
      expect(out.prUrl).toBe('https://github.com/owner/repo/pull/123');
      expect(out.draft).toBe(true);
    }
    expect(git.pushWithUpstream).toHaveBeenCalledWith('origin', 'HEAD');
    expect(api.createPR).toHaveBeenCalledWith(
      'owner',
      'repo',
      expect.any(String),
      'feature/foo',
      'main',
      expect.any(String),
      true, // draft
    );
  });

  it('honors draftByDefault: false → creates a full PR instead of a draft', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const api = makeApiStub();
    const deps = makeDeps({
      ui,
      api,
      config: makeConfig({ draftByDefault: false }),
    });

    await runDraftPullRequest(deps);

    const callArgs = (api.createPR as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[6]).toBe(false); // draft flag
  });

  it('lets user edit the title via Edit-title loop and then Submit', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Edit title', 'Submit'];
    ui.inputResponses = ['A better title'];
    const api = makeApiStub();
    const deps = makeDeps({ ui, api });

    await runDraftPullRequest(deps);

    const callArgs = (api.createPR as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2]).toBe('A better title');
  });

  it('rejects empty title in the edit loop and re-prompts', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Edit title', 'Submit'];
    ui.inputResponses = ['   '];
    const api = makeApiStub();
    const deps = makeDeps({ ui, api });

    await runDraftPullRequest(deps);

    // The empty-title error surfaces as a showError, then the confirm loop
    // runs again — second confirmResponses entry ('Submit') takes over.
    expect(ui.calls.showError.some((m) => String(m).match(/title cannot be empty/))).toBe(true);
    expect(api.createPR).toHaveBeenCalled();
  });

  it('cancels cleanly when user clicks Cancel on the confirm', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Cancel'];
    const git = makeGitStub();
    const api = makeApiStub();
    const deps = makeDeps({ ui, git: git as unknown as GitCLI, api });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('cancelled');
    expect(git.pushWithUpstream).not.toHaveBeenCalled();
    expect(api.createPR).not.toHaveBeenCalled();
  });

  it('cancels when user dismisses the Edit-title input box', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Edit title'];
    ui.inputResponses = [undefined]; // user hit Escape on input box
    const api = makeApiStub();
    const deps = makeDeps({ ui, api });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('cancelled');
    if (out.mode === 'cancelled') expect(out.reason).toBe('title-cancelled');
    expect(api.createPR).not.toHaveBeenCalled();
  });

  it('opens the body in a preview tab before asking for confirmation', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const deps = makeDeps({ ui });

    await runDraftPullRequest(deps);

    expect(ui.calls.openPreview).toHaveLength(1);
    const previewCall = ui.calls.openPreview[0] as { content: string; title: string };
    expect(previewCall.title).toMatch(/feature\/foo/);
    expect(previewCall.content).toMatch(/## Summary/);
  });
});

describe('runDraftPullRequest — error propagation', () => {
  it('surfaces a LLM failure as mode=error and shows the error toast', async () => {
    const ui = makeFakeUi();
    const client = {
      updateSystemPrompt: vi.fn(),
      complete: vi.fn().mockRejectedValue(new Error('backend down')),
    } as unknown as SideCarClient;
    const deps = makeDeps({ ui, client });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/backend down/);
  });

  it('surfaces a push failure as mode=error without calling api.createPR', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const git = makeGitStub({
      pushWithUpstream: vi.fn().mockRejectedValue(new Error('non-fast-forward')),
    });
    const api = makeApiStub();
    const deps = makeDeps({ ui, git: git as unknown as GitCLI, api });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('error');
    expect(api.createPR).not.toHaveBeenCalled();
  });

  it('surfaces an API failure after a successful push as mode=error', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const git = makeGitStub();
    const api = {
      createPR: vi.fn().mockRejectedValue(new Error('422 Validation Failed')),
    } as unknown as GitHubAPI;
    const deps = makeDeps({ ui, git: git as unknown as GitCLI, api });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/422/);
    expect(git.pushWithUpstream).toHaveBeenCalled();
  });
});

describe('runDraftPullRequest — branch protection awareness', () => {
  it('prepends a branch-protection summary to the preview when rules exist', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const api = makeApiStub(
      {},
      {
        pullRequestRequired: true,
        requiredApprovingReviews: 2,
        codeOwnersRequired: false,
        requiredStatusChecks: ['ci/lint', 'ci/test'],
        signedCommitsRequired: false,
        enforceAdmins: true,
        linearHistoryRequired: false,
        forcePushesAllowed: false,
      },
    );
    const deps = makeDeps({ ui, api });

    await runDraftPullRequest(deps);

    expect(ui.calls.openPreview).toHaveLength(1);
    const previewCall = ui.calls.openPreview[0] as { content: string; title: string };
    expect(previewCall.content).toContain('Branch protection on `main`');
    expect(previewCall.content).toContain('Pull request required');
    expect(previewCall.content).toContain('2 reviewer approvals');
    expect(previewCall.content).toContain('ci/lint, ci/test');
    // Summary sits above the generated body, separated by --- rule.
    const protectionIdx = previewCall.content.indexOf('Branch protection');
    const bodyIdx = previewCall.content.indexOf('## Summary');
    expect(protectionIdx).toBeLessThan(bodyIdx);
    expect(previewCall.content).toContain('---');
  });

  it('omits the protection section entirely when the branch is unprotected (null)', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const api = makeApiStub({}, null);
    const deps = makeDeps({ ui, api });

    await runDraftPullRequest(deps);

    const previewCall = ui.calls.openPreview[0] as { content: string; title: string };
    expect(previewCall.content).not.toContain('Branch protection');
    expect(previewCall.content).toMatch(/## Summary/);
  });

  it('never blocks the flow when getBranchProtection throws', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Submit'];
    const api = {
      createPR: vi.fn().mockResolvedValue({
        number: 42,
        title: 't',
        state: 'open',
        author: 'me',
        url: 'https://example/pr/42',
        createdAt: '2026-04-18',
      }),
      getBranchProtection: vi.fn().mockRejectedValue(new Error('403 Forbidden')),
    } as unknown as GitHubAPI;
    const deps = makeDeps({ ui, api });

    const out = await runDraftPullRequest(deps);

    expect(out.mode).toBe('created');
    // Nothing about protection appears in the preview, but the PR
    // still gets created.
    const previewCall = ui.calls.openPreview[0] as { content: string; title: string };
    expect(previewCall.content).not.toContain('Branch protection');
  });
});
