import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Debouncer } from './debounce.js';

describe('Debouncer', () => {
  let debouncer: Debouncer;

  beforeEach(() => {
    debouncer = new Debouncer();
  });

  it('shouldTrigger returns true on first call', () => {
    expect(debouncer.shouldTrigger(300)).toBe(true);
  });

  it('shouldTrigger returns false within interval', () => {
    expect(debouncer.shouldTrigger(300)).toBe(true);
    expect(debouncer.shouldTrigger(300)).toBe(false);
  });

  it('shouldTrigger returns true after interval passes', () => {
    vi.useFakeTimers();
    expect(debouncer.shouldTrigger(100)).toBe(true);
    vi.advanceTimersByTime(150);
    expect(debouncer.shouldTrigger(100)).toBe(true);
    vi.useRealTimers();
  });

  it('getSignal returns a non-aborted signal', () => {
    const signal = debouncer.getSignal();
    expect(signal.aborted).toBe(false);
  });

  it('getSignal aborts previous signal', () => {
    const first = debouncer.getSignal();
    const second = debouncer.getSignal();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it('cancel aborts current signal', () => {
    const signal = debouncer.getSignal();
    debouncer.cancel();
    expect(signal.aborted).toBe(true);
  });

  it('cancel is safe to call with no pending signal', () => {
    expect(() => debouncer.cancel()).not.toThrow();
  });

  it('cancel followed by getSignal gives fresh signal', () => {
    debouncer.cancel();
    const signal = debouncer.getSignal();
    expect(signal.aborted).toBe(false);
  });
});
