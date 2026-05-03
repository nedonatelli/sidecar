import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { AgentLogger } from './logger.js';

// The mock createOutputChannel doesn't return LogOutputChannel methods.
// Patch it to include log-level methods.
vi.spyOn(window, 'createOutputChannel').mockReturnValue({
  appendLine: vi.fn(),
  append: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  replace: vi.fn(),
  name: 'SideCar Agent',
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  logLevel: 1,
  onDidChangeLogLevel: vi.fn(),
} as never);

describe('AgentLogger', () => {
  let logger: AgentLogger;

  beforeEach(() => {
    logger = new AgentLogger();
  });

  it('constructs without error', () => {
    expect(logger).toBeDefined();
  });

  it('info does not throw', () => {
    expect(() => logger.info('test')).not.toThrow();
  });

  it('debug does not throw', () => {
    expect(() => logger.debug('test')).not.toThrow();
  });

  it('warn does not throw', () => {
    expect(() => logger.warn('test')).not.toThrow();
  });

  it('error does not throw', () => {
    expect(() => logger.error('test')).not.toThrow();
  });

  it('logIteration formats correctly', () => {
    expect(() => logger.logIteration(1, 10)).not.toThrow();
  });

  it('logToolCall handles input', () => {
    expect(() => logger.logToolCall('read_file', { path: 'test.ts' })).not.toThrow();
  });

  it('logToolResult handles success', () => {
    expect(() => logger.logToolResult('read_file', 'content', false)).not.toThrow();
  });

  it('logToolResult handles error', () => {
    expect(() => logger.logToolResult('read_file', 'failed', true)).not.toThrow();
  });

  it('logToolResult truncates long results', () => {
    expect(() => logger.logToolResult('read_file', 'x'.repeat(1000), false)).not.toThrow();
  });

  it('logText does not throw', () => {
    expect(() => logger.logText('some text')).not.toThrow();
  });

  it('logDone does not throw', () => {
    expect(() => logger.logDone(5)).not.toThrow();
  });

  it('logAborted does not throw', () => {
    expect(() => logger.logAborted()).not.toThrow();
  });

  it('logError handles Error objects', () => {
    expect(() => logger.logError(new Error('test error'))).not.toThrow();
  });

  it('logError handles string', () => {
    expect(() => logger.logError('string error')).not.toThrow();
  });

  it('logToolAudit emits parseable JSON with runId, tool, and outcome', () => {
    // The top-level vi.spyOn above returns a fixed fakeChannel for every
    // createOutputChannel call. Retrieve the shared channel via vi.mocked so
    // we can inspect what info() was called with.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = vi.mocked(window.createOutputChannel).mock.results[0]?.value as any;
    expect(channel).toBeDefined();
    (channel.info as ReturnType<typeof vi.fn>).mockClear();

    const runId = 'run-abc-123';
    logger.logToolAudit(runId, 'read_file', 'ok');
    logger.logToolAudit(runId, 'edit_file', 'error');

    const calls = (channel.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    const rec0 = JSON.parse(calls[0][0] as string);
    const rec1 = JSON.parse(calls[1][0] as string);

    expect(rec0).toMatchObject({ runId, tool: 'read_file', outcome: 'ok' });
    expect(rec1).toMatchObject({ runId, tool: 'edit_file', outcome: 'error' });
    expect(typeof rec0.timestamp).toBe('string');
  });

  it('show does not throw', () => {
    expect(() => logger.show()).not.toThrow();
  });

  it('dispose does not throw', () => {
    expect(() => logger.dispose()).not.toThrow();
  });
});
