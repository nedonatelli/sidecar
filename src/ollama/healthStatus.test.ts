import { describe, it, expect, beforeEach } from 'vitest';
import { healthStatus } from './healthStatus.js';

describe('healthStatus', () => {
  beforeEach(() => {
    healthStatus.reset();
  });

  it('starts in the unknown state on reset', () => {
    const snap = healthStatus.get();
    expect(snap.status).toBe('unknown');
    expect(snap.detail).toBeUndefined();
    expect(snap.lastError).toBeUndefined();
  });

  it('setOk transitions to ok and clears error fields', () => {
    healthStatus.setError('boom', 'full stack');
    healthStatus.setOk();
    const snap = healthStatus.get();
    expect(snap.status).toBe('ok');
    expect(snap.detail).toBeUndefined();
    expect(snap.lastError).toBeUndefined();
  });

  it('setError captures both the short detail and full error text', () => {
    healthStatus.setError('401 Unauthorized', 'Anthropic API request failed: 401 ...');
    const snap = healthStatus.get();
    expect(snap.status).toBe('error');
    expect(snap.detail).toBe('401 Unauthorized');
    expect(snap.lastError).toContain('401 ...');
  });

  it('setDegraded transitions to degraded with a reason', () => {
    healthStatus.setDegraded('rate-limited');
    const snap = healthStatus.get();
    expect(snap.status).toBe('degraded');
    expect(snap.detail).toBe('rate-limited');
  });

  it('fires onDidChange for meaningful transitions', () => {
    const fired: string[] = [];
    const sub = healthStatus.onDidChange((s) => fired.push(s.status));
    healthStatus.setOk();
    healthStatus.setError('boom');
    healthStatus.setOk();
    sub.dispose();
    expect(fired).toEqual(['ok', 'error', 'ok']);
  });

  it('does not fire onDidChange for no-op transitions', () => {
    healthStatus.setOk();
    let extraFires = 0;
    const sub = healthStatus.onDidChange(() => extraFires++);
    healthStatus.setOk();
    healthStatus.setOk();
    sub.dispose();
    expect(extraFires).toBe(0);
  });

  it('reset always fires when leaving a non-unknown state', () => {
    healthStatus.setError('boom');
    let fired = false;
    const sub = healthStatus.onDidChange(() => {
      fired = true;
    });
    healthStatus.reset();
    sub.dispose();
    expect(fired).toBe(true);
    expect(healthStatus.get().status).toBe('unknown');
  });
});
