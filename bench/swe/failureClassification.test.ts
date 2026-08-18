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

  it('classifies an unrecognised error as capability', () => {
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
