import { describe, it, expect } from 'vitest';
import { classifyFailure, isInfraFailure } from './failureClassification.js';

describe('classifyFailure', () => {
  it('classifies a fetch failure as infra', () => {
    expect(classifyFailure(new Error('fetch failed'))).toEqual({ reason: 'fetch failed', kind: 'infra' });
  });

  it('classifies an abort/termination as infra', () => {
    expect(classifyFailure(new Error('terminated')).kind).toBe('infra');
  });

  it('classifies an abort-signal error as infra', () => {
    expect(classifyFailure(new Error('The operation was aborted')).kind).toBe('infra');
  });

  it('classifies a socket hang up as infra', () => {
    expect(classifyFailure(new Error('socket hang up')).kind).toBe('infra');
  });

  it('classifies a connection refusal as infra', () => {
    expect(classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:11434')).kind).toBe('infra');
  });

  it("classifies vLLM's dead-engine error as infra", () => {
    const msg = 'openai: EngineCore encountered an issue. See stack trace (above) for the root cause.';
    expect(classifyFailure(new Error(msg)).kind).toBe('infra');
  });

  it('classifies an unrecognized error as capability', () => {
    expect(classifyFailure(new Error('cannot apply edit: anchor not found')).kind).toBe('capability');
  });

  it('handles a non-Error throw', () => {
    expect(classifyFailure('boom')).toEqual({ reason: 'boom', kind: 'capability' });
  });

  it('reports none for no error', () => {
    expect(classifyFailure(null)).toEqual({ reason: '', kind: 'none' });
    expect(classifyFailure(undefined)).toEqual({ reason: '', kind: 'none' });
  });

  it('matches case-insensitively', () => {
    expect(classifyFailure(new Error('Fetch Failed')).kind).toBe('infra');
  });
});

describe('isInfraFailure', () => {
  it('is true when the failure reason is an infra reason', () => {
    expect(isInfraFailure({ failureReason: 'fetch failed', toolCalls: 6, model_patch: '' })).toBe(true);
  });

  it('preserves the legacy zero-toolCalls heuristic', () => {
    expect(isInfraFailure({ failureReason: null, toolCalls: 0, model_patch: '' })).toBe(true);
  });

  it('is false for a genuine empty-patch capability failure', () => {
    expect(isInfraFailure({ failureReason: null, toolCalls: 12, model_patch: '' })).toBe(false);
  });

  it('is false when a patch was salvaged despite an infra failure', () => {
    expect(isInfraFailure({ failureReason: 'terminated', toolCalls: 8, model_patch: 'diff --git a b' })).toBe(false);
  });

  it('is false when an unrelated error left no patch', () => {
    expect(isInfraFailure({ failureReason: 'anchor not found', toolCalls: 9, model_patch: '' })).toBe(false);
  });

  it('treats undefined toolCalls as non-infra so old meta files are unaffected', () => {
    expect(isInfraFailure({ failureReason: null, toolCalls: undefined, model_patch: '' })).toBe(false);
  });
});

describe('repo-preparation failures are infrastructure', () => {
  // Verbatim from a 20-task run: 3 tasks died here, 0 turns, ~3s, and were
  // reported as [capability] — the exact conflation this module exists to stop.
  const gitReset = 'Command failed: git reset --hard --quiet 44c24bf02835323d5418512ebe8e76166739ebf8';

  it('classifies a failed checkout as infra, not capability', () => {
    expect(classifyFailure(new Error(gitReset)).kind).toBe('infra');
  });

  it('classifies other git plumbing failures as infra', () => {
    for (const msg of [
      'fatal: reference is not a tree: abc123',
      "error: pathspec 'deadbeef' did not match any file(s) known to git",
    ]) {
      expect(classifyFailure(new Error(msg)).kind).toBe('infra');
    }
  });

  it('still calls a model-side failure capability', () => {
    expect(classifyFailure(new Error('edit_file: search string not found')).kind).toBe('capability');
  });
});

// #292: a repository missing from SIDECAR_SWE_REPO_CACHE stops the task before
// the agent runs. Both the old per-task message and the run-level one are infra.
describe('repo cache miss is infrastructure (#292)', () => {
  it('the per-task message', () => {
    const e = new Error('repo cache miss for psf/requests at /cache/psf_requests');
    expect(classifyFailure(e).kind).toBe('infra');
  });
  it('the run-level message', () => {
    const e = new Error(
      'repo cache miss: 2 repo(s) needed by this run are not in SIDECAR_SWE_REPO_CACHE (/c): a/b, c/d.',
    );
    expect(classifyFailure(e).kind).toBe('infra');
  });
});

// #308: the v0.132.0 nemotron run printed `EMPTY [capability]` for a run the
// per-task timer ended (django-12470 scaffold-on, 60.2 min, 31 tool calls). It
// is labelled harness-timeout, and stays in the capability denominator.
describe('a per-task timeout is a harness-timeout, not a capability failure (#308)', () => {
  const reason = 'per-task timeout after 3600000ms';
  it('is labelled harness-timeout', () => {
    expect(classifyFailure(new Error(reason))).toEqual({ reason, kind: 'harness-timeout' });
  });
  it('stays in the capability denominator when the agent did work', () => {
    expect(isInfraFailure({ failureReason: reason, toolCalls: 31, model_patch: '' })).toBe(false);
  });
  it('a run that never got a response is still infra (no tool calls)', () => {
    expect(isInfraFailure({ failureReason: reason, toolCalls: 0, model_patch: '' })).toBe(true);
  });
  it('only the recorded timeout reason, not any text mentioning a timeout', () => {
    expect(classifyFailure(new Error('model returned: per-task timeout after 5ms?')).kind).toBe('capability');
  });
});
