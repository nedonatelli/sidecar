import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeCiFailure, type AnalyzeCiUi, type AnalyzeCiDeps } from './analyzeCiFailure.js';
import type { GitCLI } from '../github/git.js';
import type { GitHubAPI } from '../github/api.js';
import type { WorkflowRun, WorkflowJob } from '../github/types.js';

// ---------------------------------------------------------------------------
// Tests for analyzeCiFailure.ts (v0.68 chunk 4).
//
// Integration through the injectable UI + stubbed GitCLI + stubbed
// GitHubAPI. No network, no VS Code, no disk. Every test proves one
// branch of the typed `AnalyzeCiOutcome` or one subtle behavior
// (tail fallback, send-to-agent routing, log-fetch errors).
// ---------------------------------------------------------------------------

interface FakeUi extends AnalyzeCiUi {
  calls: {
    showInfo: string[];
    showError: string[];
    openPreview: Array<{ content: string; title: string }>;
    showConfirm: Array<{ message: string; options: readonly string[] }>;
    sendToAgent: string[];
  };
  confirmResponses: string[];
}

function makeFakeUi(): FakeUi {
  const calls: FakeUi['calls'] = {
    showInfo: [],
    showError: [],
    openPreview: [],
    showConfirm: [],
    sendToAgent: [],
  };
  const ui: FakeUi = {
    calls,
    confirmResponses: [],
    showInfo(message) {
      calls.showInfo.push(message);
    },
    showError(message) {
      calls.showError.push(message);
    },
    async openPreview(content, title) {
      calls.openPreview.push({ content, title });
    },
    async showConfirm(message, options) {
      calls.showConfirm.push({ message, options });
      return ui.confirmResponses.shift();
    },
    async sendToAgent(prompt) {
      calls.sendToAgent.push(prompt);
    },
  };
  return ui;
}

function makeGit(overrides: { branch?: string; remote?: string | null } = {}): GitCLI {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue(overrides.branch ?? 'feature/foo'),
    getRemoteUrl: vi
      .fn()
      .mockResolvedValue(overrides.remote === undefined ? 'https://github.com/owner/repo.git' : overrides.remote),
  } as unknown as GitCLI;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 999,
    name: 'CI',
    status: 'completed',
    conclusion: 'failure',
    headBranch: 'feature/foo',
    headSha: 'abc123',
    url: 'https://github.com/owner/repo/actions/runs/999',
    createdAt: '2026-04-18T10:00:00Z',
    updatedAt: '2026-04-18T10:05:00Z',
    runNumber: 42,
    event: 'push',
    ...overrides,
  };
}

function makeJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: 111,
    name: 'build',
    status: 'completed',
    conclusion: 'failure',
    url: 'https://github.com/owner/repo/actions/runs/999/jobs/111',
    startedAt: '2026-04-18T10:00:00Z',
    completedAt: '2026-04-18T10:05:00Z',
    steps: [],
    ...overrides,
  };
}

function makeApi(overrides: {
  runs?: WorkflowRun[];
  jobs?: WorkflowJob[];
  log?: string | null;
  runsError?: Error;
  jobsError?: Error;
  logError?: Error;
}): GitHubAPI {
  return {
    listWorkflowRuns: vi.fn().mockImplementation(async () => {
      if (overrides.runsError) throw overrides.runsError;
      return overrides.runs ?? [];
    }),
    listWorkflowJobs: vi.fn().mockImplementation(async () => {
      if (overrides.jobsError) throw overrides.jobsError;
      return overrides.jobs ?? [];
    }),
    getJobLogs: vi.fn().mockImplementation(async () => {
      if (overrides.logError) throw overrides.logError;
      return overrides.log ?? null;
    }),
  } as unknown as GitHubAPI;
}

function makeDeps(overrides: Partial<AnalyzeCiDeps> = {}): AnalyzeCiDeps {
  return {
    ui: makeFakeUi(),
    cwd: '/ws',
    git: makeGit(),
    api: makeApi({}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('analyzeCiFailure — bailout paths', () => {
  it('bails with mode=detached-head when current branch is empty', async () => {
    const ui = makeFakeUi();
    const git = makeGit({ branch: '' });
    const out = await analyzeCiFailure(makeDeps({ ui, git }));
    expect(out.mode).toBe('detached-head');
    expect(ui.calls.showError[0]).toMatch(/detached/i);
  });

  it('bails with mode=no-remote when origin is missing', async () => {
    const ui = makeFakeUi();
    const git = makeGit({ remote: null });
    const out = await analyzeCiFailure(makeDeps({ ui, git }));
    expect(out.mode).toBe('no-remote');
  });

  it('bails with mode=no-remote when origin is a non-GitHub URL', async () => {
    const ui = makeFakeUi();
    const git = makeGit({ remote: 'https://gitlab.com/owner/repo.git' });
    const out = await analyzeCiFailure(makeDeps({ ui, git }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns mode=no-runs when the branch has no workflow runs', async () => {
    const ui = makeFakeUi();
    const api = makeApi({ runs: [] });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('no-runs');
    expect(ui.calls.showInfo[0]).toMatch(/No workflow runs/);
  });

  it('returns mode=no-failures when every run succeeded', async () => {
    const ui = makeFakeUi();
    const api = makeApi({
      runs: [makeRun({ conclusion: 'success' })],
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('no-failures');
    if (out.mode === 'no-failures') expect(out.latestRun.conclusion).toBe('success');
  });

  it('returns mode=no-failures when latest run is still in progress', async () => {
    const ui = makeFakeUi();
    const api = makeApi({
      runs: [makeRun({ status: 'in_progress', conclusion: null })],
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('no-failures');
  });

  it('picks the latest failed run even when a success run is newer in the list', async () => {
    const ui = makeFakeUi();
    // The primitive walks in array order and picks the first
    // failing run. A later success in the list shouldn't affect it.
    const api = makeApi({
      runs: [
        makeRun({ id: 1, runNumber: 1, conclusion: 'success' }),
        makeRun({ id: 2, runNumber: 2, conclusion: 'failure' }),
      ],
      jobs: [makeJob()],
      log: '##[group]step\nctx\n##[error]Exit 1.\n##[endgroup]',
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('rendered');
    if (out.mode === 'rendered') expect(out.run.id).toBe(2);
  });
});

describe('analyzeCiFailure — rendered path', () => {
  it('fetches logs for failed jobs, extracts blocks, and opens a preview', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob({ name: 'lint' }), makeJob({ id: 112, name: 'test' })],
      log: [
        '2026-04-18T10:00:00.0000000Z ##[group]step',
        '2026-04-18T10:00:01.0000000Z context-line',
        '2026-04-18T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
        '2026-04-18T10:00:03.0000000Z ##[endgroup]',
      ].join('\n'),
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('rendered');
    expect(ui.calls.openPreview).toHaveLength(1);
    expect(ui.calls.openPreview[0].content).toContain('CI Failure — Run #42');
    expect(ui.calls.openPreview[0].content).toContain('## Job: lint');
    expect(ui.calls.openPreview[0].content).toContain('## Job: test');
    expect(ui.calls.openPreview[0].content).toContain('ERROR: Process completed');
  });

  it('skips jobs that succeeded and only processes failures', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [
        makeJob({ id: 111, name: 'lint', conclusion: 'success' }),
        makeJob({ id: 112, name: 'test', conclusion: 'failure' }),
      ],
      log: '##[group]step\nctx\n##[error]boom\n##[endgroup]',
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('rendered');
    const preview = ui.calls.openPreview[0].content;
    expect(preview).toContain('## Job: test');
    expect(preview).not.toContain('## Job: lint');
  });

  it('emits the tail-of-log fallback when no ##[error] markers are present', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob()],
      log: 'only noisy output\nno error markers at all\nbut the job still failed',
    });
    await analyzeCiFailure(makeDeps({ ui, api }));
    const preview = ui.calls.openPreview[0].content;
    expect(preview).toContain('No `##[error]` markers found');
    expect(preview).toContain('but the job still failed');
  });

  it('surfaces an _Logs unavailable_ note when the log fetch returns null (expired)', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob()],
      log: null,
    });
    await analyzeCiFailure(makeDeps({ ui, api }));
    const preview = ui.calls.openPreview[0].content;
    expect(preview).toContain('Logs unavailable');
  });

  it('surfaces an inline error note when the log fetch throws (transient)', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob()],
      logError: new Error('network reset'),
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    // The flow keeps going — one broken job doesn't abort the run
    // summary. The outcome is still `rendered` because the preview
    // opened.
    expect(out.mode).toBe('rendered');
    const preview = ui.calls.openPreview[0].content;
    expect(preview).toContain('Could not fetch logs');
    expect(preview).toContain('network reset');
  });

  it('routes the failure prompt to the agent when the user picks Send to agent', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Send to agent'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob()],
      log: '##[group]step\nctx\n##[error]boom\n##[endgroup]',
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('rendered');
    if (out.mode === 'rendered') expect(out.sentToAgent).toBe(true);
    expect(ui.calls.sendToAgent).toHaveLength(1);
    expect(ui.calls.sendToAgent[0]).toContain('CI run #42 failed');
    expect(ui.calls.sendToAgent[0]).toContain('ERROR: boom');
  });

  it('does not call sendToAgent when the user dismisses', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob()],
      log: '##[group]step\nctx\n##[error]boom\n##[endgroup]',
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    if (out.mode === 'rendered') expect(out.sentToAgent).toBe(false);
    expect(ui.calls.sendToAgent).toHaveLength(0);
  });

  it('surfaces a sendToAgent throw as showError but still returns rendered', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Send to agent'];
    ui.sendToAgent = vi.fn().mockRejectedValue(new Error('chat view missing'));
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob()],
      log: '##[group]step\nctx\n##[error]boom\n##[endgroup]',
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('rendered');
    if (out.mode === 'rendered') expect(out.sentToAgent).toBe(false);
    expect(ui.calls.showError.at(-1)).toMatch(/chat view missing/);
  });
});

describe('analyzeCiFailure — API error propagation', () => {
  it('returns mode=error when listWorkflowRuns throws', async () => {
    const ui = makeFakeUi();
    const api = makeApi({ runsError: new Error('403 Forbidden') });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/403/);
  });

  it('returns mode=error when listWorkflowJobs throws', async () => {
    const ui = makeFakeUi();
    const api = makeApi({
      runs: [makeRun()],
      jobsError: new Error('rate limited'),
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/rate limited/);
  });

  it('returns mode=no-failures when the run is marked failure but has no failing jobs', async () => {
    // Edge case: run-level conclusion is failure (e.g. a required job
    // was cancelled upstream) but `listWorkflowJobs` returns only
    // successes. Flow should not silently claim `rendered`.
    const ui = makeFakeUi();
    const api = makeApi({
      runs: [makeRun()],
      jobs: [makeJob({ conclusion: 'success' })],
    });
    const out = await analyzeCiFailure(makeDeps({ ui, api }));
    expect(out.mode).toBe('no-failures');
  });
});
