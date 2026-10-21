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

  // #227 (from #121): only `Array.isArray(messages)` was checked, so any
  // array element was accepted and loaded straight into the chat.
  it.each([
    ['a non-object message', ['hello']],
    ['an unknown role', [{ role: 'system', content: 'x' }]],
    ['non-string, non-array content', [{ role: 'user', content: 42 }]],
    ['an unknown block type', [{ role: 'user', content: [{ type: 'video', url: 'x' }] }]],
    ['a text block without text', [{ role: 'assistant', content: [{ type: 'text' }] }]],
    ['a tool_result without string content', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }]],
  ])('rejects a bundle containing %s', (_label, messages) => {
    const r = parseBundle(JSON.stringify({ version: 1, exportedAt: 0, task: 'x', note: '', messages }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/message 1/i);
  });

  it('accepts structured content blocks', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      },
    ];
    const r = parseBundle(JSON.stringify({ version: 1, exportedAt: 0, task: 'go', note: '', messages }));
    expect(r.ok).toBe(true);
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
