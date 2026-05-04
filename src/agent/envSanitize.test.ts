import { describe, it, expect } from 'vitest';
import { sanitizeEnvValue } from './envSanitize.js';

describe('sanitizeEnvValue', () => {
  it('passes through clean ASCII strings unchanged', () => {
    expect(sanitizeEnvValue('hello world')).toBe('hello world');
    expect(sanitizeEnvValue('KEY=value_123-ABC')).toBe('KEY=value_123-ABC');
  });

  it('preserves newline (\\n) and carriage return (\\r)', () => {
    expect(sanitizeEnvValue('line1\nline2')).toBe('line1\nline2');
    expect(sanitizeEnvValue('line1\r\nline2')).toBe('line1\r\nline2');
  });

  it('preserves horizontal tab (\\t)', () => {
    expect(sanitizeEnvValue('col1\tcol2')).toBe('col1\tcol2');
  });

  it('removes null bytes', () => {
    expect(sanitizeEnvValue('ab\x00cd')).toBe('abcd');
    expect(sanitizeEnvValue('\x00secret')).toBe('secret');
  });

  it('removes control characters \\x01–\\x08', () => {
    const input = '\x01\x02\x03\x04\x05\x06\x07\x08clean';
    expect(sanitizeEnvValue(input)).toBe('clean');
  });

  it('removes vertical tab (\\x0b) and form feed (\\x0c)', () => {
    expect(sanitizeEnvValue('a\x0bb')).toBe('ab');
    expect(sanitizeEnvValue('a\x0cb')).toBe('ab');
  });

  it('removes control characters \\x0e–\\x1f', () => {
    let input = '';
    for (let i = 0x0e; i <= 0x1f; i++) input += String.fromCharCode(i);
    expect(sanitizeEnvValue(input + 'ok')).toBe('ok');
  });

  it('removes DEL (\\x7f)', () => {
    expect(sanitizeEnvValue('abc\x7fdef')).toBe('abcdef');
  });

  it('removes terminal escape sequences (ESC is \\x1b)', () => {
    expect(sanitizeEnvValue('\x1b[31mred text\x1b[0m')).toBe('[31mred text[0m');
  });

  it('preserves PEM certificate-style multi-line values', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBxxx\n-----END CERTIFICATE-----';
    expect(sanitizeEnvValue(pem)).toBe(pem);
  });

  it('handles empty string', () => {
    expect(sanitizeEnvValue('')).toBe('');
  });

  it('handles a string with only control characters', () => {
    expect(sanitizeEnvValue('\x00\x01\x02\x7f')).toBe('');
  });
});
