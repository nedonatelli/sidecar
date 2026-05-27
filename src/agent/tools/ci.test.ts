import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    ciAnalysisEnabled: true,
    ciAnalysisJobFilter: ['*'],
    ciAnalysisMaxLogBytes: 5_000_000,
  })),
}));

vi.mock('../../github/git.js', () => ({
  GitCLI: vi.fn().mockImplementation(() => ({
    getCurrentBranch: vi.fn().mockResolvedValue('main'),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
  })),
}));

vi.mock('../../github/api.js', () => ({
  GitHubAPI: Object.assign(
    vi.fn().mockImplementation(() => ({
      listWorkflowRuns: vi.fn().mockResolvedValue([]),
      listWorkflowJobs: vi.fn().mockResolvedValue([]),
      getJobLogs: vi.fn().mockResolvedValue(null),
    })),
    { parseRepo: vi.fn().mockReturnValue({ owner: 'owner', repo: 'repo' }) },
  ),
}));

vi.mock('../../github/auth.js', () => ({
  getGitHubToken: vi.fn().mockResolvedValue('ghp_test_token'),
}));

vi.mock('../../ci/logParser.js', () => ({
  parseJobLog: vi.fn().mockReturnValue({ truncated: false, failedSteps: [], rawLineCount: 0 }),
}));

import { analyzeCiFailureDef, analyzeCiFailureTool, ciTools } from './ci.js';
import { getConfig } from '../../config/settings.js';
import { GitCLI } from '../../github/git.js';
import { GitHubAPI } from '../../github/api.js';
import { getGitHubToken } from '../../github/auth.js';
import { parseJobLog } from '../../ci/logParser.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof vi.fn<any>>;

function makeGitMock(): { getCurrentBranch: AnyMock; getRemoteUrl: AnyMock } {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue('main'),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
  };
}

function makeApiInstance(): { listWorkflowRuns: AnyMock; listWorkflowJobs: AnyMock; getJobLogs: AnyMock } {
  return {
    listWorkflowRuns: vi.fn().mockResolvedValue([]),
    listWorkflowJobs: vi.fn().mockResolvedValue([]),
    getJobLogs: vi.fn().mockResolvedValue(null),
  };
}

function makeRun(
  overrides: Partial<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    runNumber: number;
    url: string;
  }> = {},
) {
  return {
    id: 1,
    name: 'CI',
    status: 'completed',
    conclusion: 'failure',
    runNumber: 42,
    url: 'https://github.com/owner/repo/actions/runs/1',
    ...overrides,
  };
}

function makeJob(
  overrides: Partial<{
    id: number;
    name: string;
    conclusion: string;
    steps: Array<{ name: string; conclusion: string }>;
  }> = {},
) {
  return {
    id: 100,
    name: 'test',
    conclusion: 'failure',
    steps: [],
    ...overrides,
  };
}

describe('analyzeCiFailureDef', () => {
  it('has name analyze_ci_failure', () => {
    expect(analyzeCiFailureDef.name).toBe('analyze_ci_failure');
  });
});

describe('ciTools', () => {
  it('has exactly one registered tool', () => {
    expect(ciTools).toHaveLength(1);
  });

  it('registered tool definition matches analyzeCiFailureDef', () => {
    expect(ciTools[0].definition).toBe(analyzeCiFailureDef);
  });
});

describe('analyzeCiFailureTool', () => {
  // Per-test git/api mock instances, re-created in beforeEach
  let gitInstance: ReturnType<typeof makeGitMock>;
  let apiInstance: ReturnType<typeof makeApiInstance>;

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      ciAnalysisEnabled: true,
      ciAnalysisJobFilter: ['*'],
      ciAnalysisMaxLogBytes: 5_000_000,
    } as ReturnType<typeof getConfig>);

    gitInstance = makeGitMock();
    apiInstance = makeApiInstance();

    // Use a real function body so vitest can use it as a constructor
    vi.mocked(GitCLI).mockImplementation(function () {
      return gitInstance;
    } as unknown as typeof GitCLI);

    vi.mocked(GitHubAPI).mockImplementation(function () {
      return apiInstance;
    } as unknown as typeof GitHubAPI);

    vi.mocked(GitHubAPI.parseRepo).mockReturnValue({ owner: 'owner', repo: 'repo' });
    vi.mocked(getGitHubToken).mockResolvedValue('ghp_test_token');
    vi.mocked(parseJobLog).mockReturnValue({ truncated: false, failedSteps: [], rawLineCount: 0 });
  });

  it('returns disabled message when ciAnalysisEnabled is false', async () => {
    vi.mocked(getConfig).mockReturnValue({
      ciAnalysisEnabled: false,
      ciAnalysisJobFilter: ['*'],
      ciAnalysisMaxLogBytes: 5_000_000,
    } as ReturnType<typeof getConfig>);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/disabled/i);
    expect(result).toMatch(/sidecar\.ci\.analysis\.enabled/);
  });

  it('returns branch-detached message when getCurrentBranch returns empty string', async () => {
    gitInstance.getCurrentBranch.mockResolvedValue('');

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/detached/i);
  });

  it('returns no-remote message when getRemoteUrl returns null', async () => {
    gitInstance.getRemoteUrl.mockResolvedValue(null as unknown as string);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/No "origin" remote/);
  });

  it('returns non-github message when GitHubAPI.parseRepo returns null', async () => {
    vi.mocked(GitHubAPI.parseRepo).mockReturnValue(null);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/isn't a GitHub repo/);
  });

  it('returns no-token message when getGitHubToken throws', async () => {
    vi.mocked(getGitHubToken).mockRejectedValue(new Error('no token'));

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/No GitHub token/);
    expect(result).toMatch(/actions:read/);
  });

  it('returns "no failed runs" with "No runs" hint when runs array is empty', async () => {
    apiInstance.listWorkflowRuns.mockResolvedValue([]);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/No failed CI runs/);
    expect(result).toMatch(/No runs found for this branch/);
  });

  it('returns "no failed runs" with latest-run hint when runs exist but none are failed', async () => {
    const successRun = makeRun({ conclusion: 'success', name: 'Build', status: 'completed' });
    apiInstance.listWorkflowRuns.mockResolvedValue([successRun]);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/No failed CI runs/);
    expect(result).toMatch(/Build/);
    expect(result).toMatch(/success/);
  });

  it('returns "no individual jobs failed" when failedRun exists but all jobs passed', async () => {
    const failedRun = makeRun({ conclusion: 'failure', runNumber: 7, url: 'https://github.com/runs/7' });
    const passedJob = makeJob({ conclusion: 'success' });
    apiInstance.listWorkflowRuns.mockResolvedValue([failedRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([passedJob]);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/Run #7 failed but no individual jobs/);
    expect(result).toMatch(/https:\/\/github\.com\/runs\/7/);
  });

  it('returns "no jobs matched filter" when job_filter does not match failed job names', async () => {
    const failedRun = makeRun({ conclusion: 'failure' });
    const failedJob = makeJob({ name: 'build', conclusion: 'failure' });
    apiInstance.listWorkflowRuns.mockResolvedValue([failedRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([failedJob]);

    const result = await analyzeCiFailureTool({ job_filter: ['lint'] });
    expect(result).toMatch(/No failed jobs matched filter/);
    expect(result).toMatch(/lint/);
    expect(result).toMatch(/`build`/);
  });

  it('returns markdown summary with job name and step info when a failed job has failed steps with a log', async () => {
    const failedRun = makeRun({ conclusion: 'failure', runNumber: 99, name: 'CI Pipeline' });
    const failedJob = makeJob({
      name: 'test',
      conclusion: 'failure',
      steps: [{ name: 'Run tests', conclusion: 'failure' }],
    });
    apiInstance.listWorkflowRuns.mockResolvedValue([failedRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([failedJob]);
    apiInstance.getJobLogs.mockResolvedValue('raw log output');

    vi.mocked(parseJobLog).mockReturnValue({
      truncated: false,
      failedSteps: [{ name: 'Run tests', errorLines: ['Error: test failed', 'exit code 1'] }],
      rawLineCount: 50,
    });

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/## CI Failure Analysis/);
    expect(result).toMatch(/`test`/);
    expect(result).toMatch(/`Run tests`/);
    expect(result).toMatch(/Error: test failed/);
    expect(result).toMatch(/exit code 1/);
    expect(result).toMatch(/CI Pipeline/);
    expect(result).toMatch(/#99/);
  });

  it('only returns analysis for the matched job when job_filter specifies a name', async () => {
    const failedRun = makeRun({ conclusion: 'failure' });
    const lintJob = makeJob({ id: 101, name: 'lint', conclusion: 'failure', steps: [] });
    const testJob = makeJob({ id: 102, name: 'test', conclusion: 'failure', steps: [] });
    apiInstance.listWorkflowRuns.mockResolvedValue([failedRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([lintJob, testJob]);
    apiInstance.getJobLogs.mockResolvedValue('log output');
    vi.mocked(parseJobLog).mockReturnValue({ truncated: false, failedSteps: [], rawLineCount: 5 });

    const result = await analyzeCiFailureTool({ job_filter: ['lint'] });
    expect(result).toMatch(/`lint`/);
    expect(result).not.toMatch(/### Failed job: `test`/);
  });

  it('uses timed_out conclusion as a failed run', async () => {
    const timedOutRun = makeRun({ conclusion: 'timed_out', runNumber: 5 });
    const failedJob = makeJob({ name: 'slow-job', conclusion: 'timed_out' });
    apiInstance.listWorkflowRuns.mockResolvedValue([timedOutRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([failedJob]);
    apiInstance.getJobLogs.mockResolvedValue('timeout log');

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/## CI Failure Analysis/);
    expect(result).toMatch(/`slow-job`/);
  });

  it('shows log-unavailable message when getJobLogs returns null', async () => {
    const failedRun = makeRun({ conclusion: 'failure' });
    const failedJob = makeJob({ name: 'build', conclusion: 'failure', steps: [] });
    apiInstance.listWorkflowRuns.mockResolvedValue([failedRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([failedJob]);
    apiInstance.getJobLogs.mockResolvedValue(null);

    const result = await analyzeCiFailureTool({});
    expect(result).toMatch(/Log unavailable/);
  });

  it('falls back to config ciAnalysisJobFilter when job_filter input is not an array of strings', async () => {
    vi.mocked(getConfig).mockReturnValue({
      ciAnalysisEnabled: true,
      ciAnalysisJobFilter: ['build'],
      ciAnalysisMaxLogBytes: 5_000_000,
    } as ReturnType<typeof getConfig>);

    const failedRun = makeRun({ conclusion: 'failure' });
    const testJob = makeJob({ name: 'test', conclusion: 'failure' });
    apiInstance.listWorkflowRuns.mockResolvedValue([failedRun]);
    apiInstance.listWorkflowJobs.mockResolvedValue([testJob]);

    // job_filter is not a valid array of strings — should fall back to config ['build']
    const result = await analyzeCiFailureTool({ job_filter: 42 });
    expect(result).toMatch(/No failed jobs matched filter/);
    expect(result).toMatch(/"build"/);
  });
});
