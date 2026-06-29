import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { logger, kv, SESSION_ID } from './logger.js';

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

describe('kv', () => {
  it('formats fields into a greppable key=value suffix', () => {
    expect(kv({ queued: 4230, skipped: 12 })).toBe(' queued=4230 skipped=12');
  });

  it('quotes values containing whitespace and renders booleans/null bare', () => {
    expect(kv({ ok: true, top: null, label: 'two words' })).toBe(' ok=true top=null label="two words"');
  });

  it('omits undefined fields entirely', () => {
    expect(kv({ a: 1, b: undefined, c: 3 })).toBe(' a=1 c=3');
  });

  it('returns an empty string for no fields', () => {
    expect(kv({})).toBe('');
  });
});

describe('SESSION_ID', () => {
  it('is a short 6-char hex id', () => {
    expect(SESSION_ID).toMatch(/^[0-9a-f]{6}$/);
  });
});
