import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  markPrReady,
  checkPrCi,
  formatCheckRunsMarkdown,
  type PrMarkReadyUi,
  type PrMarkReadyDeps,
  type PrCiUi,
  type PrCiDeps,
} from './prLifecycle.js';
import type { GitCLI } from '../github/git.js';
import type { GitHubAPI } from '../github/api.js';
import type { PullRequest, CheckRun } from '../github/types.js';

// ---------------------------------------------------------------------------
// Tests for prLifecycle.ts (v0.69 chunk 4).
// ---------------------------------------------------------------------------

function makeGit(overrides: { branch?: string; remote?: string | null } = {}): GitCLI {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue(overrides.branch ?? 'feature/auth'),
    getRemoteUrl: vi
      .fn()
      .mockResolvedValue(overrides.remote === undefined ? 'https://github.com/owner/repo.git' : overrides.remote),
  } as unknown as GitCLI;
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: 'Fix auth middleware',
    state: 'open',
    draft: true,
    author: 'dev',
    url: 'https://github.com/owner/repo/pull/42',
    headBranch: 'feature/auth',
    headSha: 'abc1234567890',
    baseBranch: 'main',
    createdAt: '2026-04-19T10:00:00Z',
    ...overrides,
  };
}

function makeCheckRun(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 1,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/owner/repo/actions/runs/1',
    startedAt: '2026-04-19T10:00:00Z',
    completedAt: '2026-04-19T10:05:00Z',
    ...overrides,
  };
}

function makeMarkReadyUi(): PrMarkReadyUi & { calls: { showInfo: string[]; showError: string[] } } {
  const calls = { showInfo: [] as string[], showError: [] as string[] };
  return {
    calls,
    showInfo(m) {
      calls.showInfo.push(m);
    },
    showError(m) {
      calls.showError.push(m);
    },
  };
}

function makeCiUi(): PrCiUi & {
  calls: { showInfo: string[]; showError: string[]; openPreview: string[]; sendToAgent: string[] };
} {
  const calls = {
    showInfo: [] as string[],
    showError: [] as string[],
    openPreview: [] as string[],
    sendToAgent: [] as string[],
  };
  return {
    calls,
    showInfo(m) {
      calls.showInfo.push(m);
    },
    showError(m) {
      calls.showError.push(m);
    },
    async openPreview(content) {
      calls.openPreview.push(content);
    },
    async sendToAgent(prompt) {
      calls.sendToAgent.push(prompt);
    },
  };
}

function makeMarkReadyApi(overrides: {
  prs?: PullRequest[];
  updatedPr?: PullRequest;
  prsError?: Error;
  markError?: Error;
}): GitHubAPI {
  return {
    listPullRequestsForBranch: vi.fn().mockImplementation(async () => {
      if (overrides.prsError) throw overrides.prsError;
      return overrides.prs ?? [];
    }),
    markPrReadyForReview: vi.fn().mockImplementation(async () => {
      if (overrides.markError) throw overrides.markError;
      return overrides.updatedPr ?? makePr({ draft: false });
    }),
  } as unknown as GitHubAPI;
}

function makeCiApi(overrides: {
  prs?: PullRequest[];
  runs?: CheckRun[];
  prsError?: Error;
  runsError?: Error;
}): GitHubAPI {
  return {
    listPullRequestsForBranch: vi.fn().mockImplementation(async () => {
      if (overrides.prsError) throw overrides.prsError;
      return overrides.prs ?? [];
    }),
    getPRCheckRuns: vi.fn().mockImplementation(async () => {
      if (overrides.runsError) throw overrides.runsError;
      return overrides.runs ?? [];
    }),
  } as unknown as GitHubAPI;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// markPrReady
// ---------------------------------------------------------------------------

describe('markPrReady — bail-out paths', () => {
  function deps(overrides: Partial<PrMarkReadyDeps> = {}): PrMarkReadyDeps {
    return { ui: makeMarkReadyUi(), cwd: '/ws', git: makeGit(), api: makeMarkReadyApi({}), ...overrides };
  }

  it('returns detached-head when branch is empty', async () => {
    const ui = makeMarkReadyUi();
    const out = await markPrReady(deps({ ui, git: makeGit({ branch: '' }) }));
    expect(out.mode).toBe('detached-head');
    expect(ui.calls.showError[0]).toMatch(/detached/i);
  });

  it('returns no-remote when remote is null', async () => {
    const out = await markPrReady(deps({ git: makeGit({ remote: null }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-remote for non-GitHub URL', async () => {
    const out = await markPrReady(deps({ git: makeGit({ remote: 'https://gitlab.com/o/r' }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-pr when no matching PR', async () => {
    const ui = makeMarkReadyUi();
    const out = await markPrReady(deps({ ui, api: makeMarkReadyApi({ prs: [] }) }));
    expect(out.mode).toBe('no-pr');
    if (out.mode === 'no-pr') expect(out.branch).toBe('feature/auth');
  });

  it('returns already-ready when PR is not a draft', async () => {
    const ui = makeMarkReadyUi();
    const readyPr = makePr({ draft: false });
    const out = await markPrReady(deps({ ui, api: makeMarkReadyApi({ prs: [readyPr] }) }));
    expect(out.mode).toBe('already-ready');
    if (out.mode === 'already-ready') expect(out.pr.number).toBe(42);
    expect(ui.calls.showInfo[0]).toMatch(/already ready/i);
  });
});

describe('markPrReady — success path', () => {
  function deps(overrides: Partial<PrMarkReadyDeps> = {}): PrMarkReadyDeps {
    return {
      ui: makeMarkReadyUi(),
      cwd: '/ws',
      git: makeGit(),
      api: makeMarkReadyApi({ prs: [makePr()] }),
      ...overrides,
    };
  }

  it('calls markPrReadyForReview and returns marked-ready', async () => {
    const updatedPr = makePr({ draft: false });
    const api = makeMarkReadyApi({ prs: [makePr()], updatedPr });
    const ui = makeMarkReadyUi();
    const out = await markPrReady(deps({ ui, api }));
    expect(out.mode).toBe('marked-ready');
    if (out.mode === 'marked-ready') expect(out.pr.draft).toBe(false);
    expect(ui.calls.showInfo[0]).toMatch(/ready for review/i);
  });

  it('returns error when markPrReadyForReview throws', async () => {
    const api = makeMarkReadyApi({ prs: [makePr()], markError: new Error('422 Unprocessable') });
    const out = await markPrReady(deps({ api }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/422/);
  });

  it('returns error when listPullRequestsForBranch throws', async () => {
    const api = makeMarkReadyApi({ prsError: new Error('403 Forbidden') });
    const out = await markPrReady(deps({ api }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/403/);
  });
});

// ---------------------------------------------------------------------------
// checkPrCi
// ---------------------------------------------------------------------------

describe('checkPrCi — bail-out paths', () => {
  function deps(overrides: Partial<PrCiDeps> = {}): PrCiDeps {
    return { ui: makeCiUi(), cwd: '/ws', git: makeGit(), api: makeCiApi({}), ...overrides };
  }

  it('returns detached-head when branch is empty', async () => {
    const ui = makeCiUi();
    const out = await checkPrCi(deps({ ui, git: makeGit({ branch: '' }) }));
    expect(out.mode).toBe('detached-head');
    expect(ui.calls.showError[0]).toMatch(/detached/i);
  });

  it('returns no-remote when remote is null', async () => {
    const out = await checkPrCi(deps({ git: makeGit({ remote: null }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-pr when no matching PR', async () => {
    const out = await checkPrCi(deps({ api: makeCiApi({ prs: [] }) }));
    expect(out.mode).toBe('no-pr');
  });

  it('returns no-checks when the PR has no check runs', async () => {
    const ui = makeCiUi();
    const out = await checkPrCi(deps({ ui, api: makeCiApi({ prs: [makePr()], runs: [] }) }));
    expect(out.mode).toBe('no-checks');
    if (out.mode === 'no-checks') expect(out.pr.number).toBe(42);
    expect(ui.calls.showInfo[0]).toMatch(/no CI checks/i);
  });
});

describe('checkPrCi — rendered path', () => {
  function deps(runs: CheckRun[], overrides: Partial<PrCiDeps> = {}): PrCiDeps {
    return {
      ui: makeCiUi(),
      cwd: '/ws',
      git: makeGit(),
      api: makeCiApi({ prs: [makePr()], runs }),
      ...overrides,
    };
  }

  it('returns rendered when checks are present', async () => {
    const ui = makeCiUi();
    const run = makeCheckRun();
    const out = await checkPrCi(deps([run], { ui }));
    expect(out.mode).toBe('rendered');
    if (out.mode === 'rendered') {
      expect(out.pr.number).toBe(42);
      expect(out.runs).toHaveLength(1);
      expect(out.allPassed).toBe(true);
    }
    expect(ui.calls.openPreview).toHaveLength(1);
  });

  it('opens preview containing PR number and check names', async () => {
    const ui = makeCiUi();
    await checkPrCi(deps([makeCheckRun({ name: 'unit-tests' })], { ui }));
    const content = ui.calls.openPreview[0];
    expect(content).toContain('PR #42');
    expect(content).toContain('unit-tests');
  });

  it('allPassed is false when a check failed', async () => {
    const run = makeCheckRun({ conclusion: 'failure' });
    const out = await checkPrCi(deps([run]));
    if (out.mode === 'rendered') expect(out.allPassed).toBe(false);
  });

  it('sends failed checks to the agent', async () => {
    const ui = makeCiUi();
    const runs = [makeCheckRun({ name: 'lint', conclusion: 'failure' })];
    await checkPrCi(deps(runs, { ui }));
    expect(ui.calls.sendToAgent).toHaveLength(1);
    expect(ui.calls.sendToAgent[0]).toContain('lint');
    expect(ui.calls.sendToAgent[0]).toContain('PR #42');
  });

  it('does not send to agent when all checks pass', async () => {
    const ui = makeCiUi();
    await checkPrCi(deps([makeCheckRun({ conclusion: 'success' })], { ui }));
    expect(ui.calls.sendToAgent).toHaveLength(0);
  });

  it('returns error when getPRCheckRuns throws', async () => {
    const out = await checkPrCi(
      deps([], {
        api: makeCiApi({ prs: [makePr()], runsError: new Error('500') }),
      }),
    );
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/500/);
  });

  it('uses the PR headSha as the ref for check runs', async () => {
    const api = makeCiApi({ prs: [makePr({ headSha: 'deadbeef' })], runs: [makeCheckRun()] });
    await checkPrCi(deps([], { api }));
    expect(api.getPRCheckRuns as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('owner', 'repo', 'deadbeef');
  });
});

// ---------------------------------------------------------------------------
// formatCheckRunsMarkdown
// ---------------------------------------------------------------------------

describe('formatCheckRunsMarkdown', () => {
  it('includes PR number and branch in the heading', () => {
    const md = formatCheckRunsMarkdown(makePr(), [makeCheckRun()]);
    expect(md).toContain('PR #42');
    expect(md).toContain('feature/auth');
  });

  it('shows truncated head SHA', () => {
    const md = formatCheckRunsMarkdown(makePr(), [makeCheckRun()]);
    expect(md).toContain('abc12345');
  });

  it('shows ✅ when all checks pass', () => {
    const md = formatCheckRunsMarkdown(makePr(), [makeCheckRun({ conclusion: 'success' })]);
    expect(md).toContain('✅');
    expect(md).toContain('passed');
  });

  it('shows ❌ when any check fails', () => {
    const md = formatCheckRunsMarkdown(makePr(), [makeCheckRun({ conclusion: 'failure' })]);
    expect(md).toContain('❌');
    expect(md).toContain('failed');
  });

  it('shows ⏳ when checks are still in progress', () => {
    const md = formatCheckRunsMarkdown(makePr(), [makeCheckRun({ status: 'in_progress', conclusion: null })]);
    expect(md).toContain('⏳');
    expect(md).toContain('in progress');
  });

  it('renders a table row per check run', () => {
    const runs = [
      makeCheckRun({ name: 'lint', conclusion: 'success' }),
      makeCheckRun({ id: 2, name: 'tests', conclusion: 'failure' }),
    ];
    const md = formatCheckRunsMarkdown(makePr(), runs);
    expect(md).toContain('lint');
    expect(md).toContain('tests');
    expect(md).toContain('| lint |');
    expect(md).toContain('| tests |');
  });
});
