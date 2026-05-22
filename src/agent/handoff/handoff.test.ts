import { describe, it, expect } from 'vitest';
import { buildBundle, parseBundle, formatExportedAt } from './handoff.js';
import type { ChatMessage } from '../../ollama/types.js';

function msg(role: 'user' | 'assistant', text: string): ChatMessage {
  return { role, content: text };
}

describe('buildBundle', () => {
  it('sets version to 1', () => {
    const b = buildBundle([msg('user', 'hello')], '');
    expect(b.version).toBe(1);
  });

  it('captures exportedAt as a recent timestamp', () => {
    const before = Date.now();
    const b = buildBundle([], '');
    expect(b.exportedAt).toBeGreaterThanOrEqual(before);
    expect(b.exportedAt).toBeLessThanOrEqual(Date.now());
  });

  it('extracts task from first user message', () => {
    const messages = [msg('assistant', 'hi'), msg('user', 'refactor auth'), msg('user', 'second')];
    const b = buildBundle(messages, '');
    expect(b.task).toBe('refactor auth');
  });

  it('truncates task to 120 chars with ellipsis', () => {
    const long = 'a'.repeat(200);
    const b = buildBundle([msg('user', long)], '');
    expect(b.task.length).toBeLessThanOrEqual(121); // 120 + ellipsis char
    expect(b.task).toMatch(/…$/);
  });

  it('returns (no task) when no user messages', () => {
    const b = buildBundle([msg('assistant', 'hello')], '');
    expect(b.task).toBe('(no task)');
  });

  it('stores the note verbatim', () => {
    const b = buildBundle([], 'auth done, tests remain');
    expect(b.note).toBe('auth done, tests remain');
  });

  it('serializes string content messages', () => {
    const b = buildBundle([msg('user', 'hello'), msg('assistant', 'world')], '');
    expect(b.messages).toHaveLength(2);
    expect(b.messages[0].role).toBe('user');
  });
});

describe('parseBundle', () => {
  it('rejects non-JSON input', () => {
    const r = parseBundle('not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/i);
  });

  it('rejects non-object JSON', () => {
    const r = parseBundle('"a string"');
    expect(r.ok).toBe(false);
  });

  it('rejects missing version', () => {
    const r = parseBundle(JSON.stringify({ messages: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version/i);
  });

  it('rejects unsupported version', () => {
    const r = parseBundle(JSON.stringify({ version: 2, messages: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version/i);
  });

  it('rejects missing messages field', () => {
    const r = parseBundle(JSON.stringify({ version: 1, task: 'x', note: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/messages/i);
  });

  it('returns ok for a valid bundle', () => {
    const bundle = { version: 1, exportedAt: Date.now(), task: 'x', note: '', messages: [] };
    const r = parseBundle(JSON.stringify(bundle));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundle.version).toBe(1);
  });

  it('round-trips buildBundle output', () => {
    const messages = [msg('user', 'add tests'), msg('assistant', 'sure')];
    const bundle = buildBundle(messages, 'in progress');
    const r = parseBundle(JSON.stringify(bundle));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bundle.note).toBe('in progress');
      expect(r.bundle.task).toBe('add tests');
      expect(r.bundle.messages).toHaveLength(2);
    }
  });
});

describe('formatExportedAt', () => {
  it('returns a non-empty string for a valid timestamp', () => {
    const s = formatExportedAt(1_700_000_000_000);
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
});
