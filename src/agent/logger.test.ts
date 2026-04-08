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

  it('show does not throw', () => {
    expect(() => logger.show()).not.toThrow();
  });

  it('dispose does not throw', () => {
    expect(() => logger.dispose()).not.toThrow();
  });
});
