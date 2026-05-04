import { describe, it, expect } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });

  it('strips SGR color sequences (CSI)', () => {
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red');
    expect(stripAnsi('\x1B[1;32mbold green\x1B[0m')).toBe('bold green');
  });

  it('strips cursor motion CSI sequences', () => {
    expect(stripAnsi('\x1B[2J')).toBe(''); // erase display
    expect(stripAnsi('\x1B[3;4H')).toBe(''); // cursor position
    expect(stripAnsi('\x1B[?25l')).toBe(''); // hide cursor
  });

  it('strips OSC sequences terminated by BEL', () => {
    // Hyperlink: ESC ] 8 ; ; url BEL
    expect(stripAnsi('\x1B]8;;https://example.com\x07link text\x1B]8;;\x07')).toBe('link text');
  });

  it('strips OSC sequences terminated by ST (ESC \\)', () => {
    expect(stripAnsi('\x1B]0;window title\x1B\\')).toBe('');
  });

  it('strips two-byte Fp/Fs escape sequences', () => {
    expect(stripAnsi('\x1B=')).toBe(''); // DECKPAM
    expect(stripAnsi('\x1B>')).toBe(''); // DECKPNM
    expect(stripAnsi('\x1B7')).toBe(''); // DECSC
    expect(stripAnsi('\x1B8')).toBe(''); // DECRC
  });

  it('strips sequences embedded in real output', () => {
    const input = '\x1B[32m✔\x1B[0m compiled successfully';
    expect(stripAnsi(input)).toBe('✔ compiled successfully');
  });

  it('strips multiple interleaved sequences', () => {
    const input = '\x1B[1m\x1B[33mwarning:\x1B[0m something happened\n';
    expect(stripAnsi(input)).toBe('warning: something happened\n');
  });

  it('does not alter unicode characters', () => {
    const input = 'こんにちは 🌍';
    expect(stripAnsi(input)).toBe(input);
  });

  it('strips sequences at start and end only', () => {
    expect(stripAnsi('\x1B[31m\x1B[0m')).toBe('');
  });

  it('preserves newlines and tabs', () => {
    const input = 'line1\n\tindented\r\n';
    expect(stripAnsi(input)).toBe(input);
  });
});
