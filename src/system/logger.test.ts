import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { logger } from './logger.js';

describe('logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes each level through the LogOutputChannel', () => {
    const calls: Record<string, unknown[]> = {};
    const fakeChannel = {
      trace: (...a: unknown[]) => (calls.trace = a),
      debug: (...a: unknown[]) => (calls.debug = a),
      info: (...a: unknown[]) => (calls.info = a),
      warn: (...a: unknown[]) => (calls.warn = a),
      error: (...a: unknown[]) => (calls.error = a),
    };
    vi.spyOn(window, 'createOutputChannel').mockReturnValue(fakeChannel as never);

    logger.info('hello', 1);
    logger.warn('careful');
    logger.error('boom');
    logger.debug('dbg');
    logger.trace('trc');

    expect(calls.info).toEqual(['hello', 1]);
    expect(calls.warn).toEqual(['careful']);
    expect(calls.error).toEqual(['boom']);
    expect(calls.debug).toEqual(['dbg']);
    expect(calls.trace).toEqual(['trc']);
  });

  it('creates the channel lazily and reuses it across calls', () => {
    const spy = vi.spyOn(window, 'createOutputChannel');
    const before = spy.mock.calls.length;
    logger.info('a');
    logger.info('b');
    logger.warn('c');
    // The module-level channel is created at most once for the whole process;
    // these calls must not each spin up a new channel.
    expect(spy.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});
