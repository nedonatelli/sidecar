import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from './sessions.js';
import type { Memento } from 'vscode';
import type { ChatMessage } from '../ollama/types.js';

function createMockMemento(): Memento {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => store.get(key) ?? defaultValue),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    keys: vi.fn(() => [...store.keys()]),
    setKeysForSync: vi.fn(),
  } as unknown as Memento;
}

describe('SessionManager', () => {
  let memento: Memento;
  let manager: SessionManager;

  beforeEach(() => {
    memento = createMockMemento();
    manager = new SessionManager(memento);
  });

  it('list returns empty array initially', () => {
    expect(manager.list()).toEqual([]);
  });

  it('save creates a session and persists it', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const session = manager.save('Test Chat', messages);

    expect(session.id).toMatch(/^session_\d+$/);
    expect(session.name).toBe('Test Chat');
    expect(session.messages).toHaveLength(2);
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it('save preserves tool_use and tool_result blocks', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that' },
          { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'app.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file contents' }],
      },
    ];
    const session = manager.save('Tool Chat', messages);

    // Assistant message should have both blocks preserved
    const assistantContent = session.messages[0].content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const blocks = assistantContent as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);

    // User message with tool_result should be preserved
    const userContent = session.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
  });

  it('save strips image blocks', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'huge-base64-data' } },
        ],
      },
    ];
    const session = manager.save('Image Chat', messages);

    // Should flatten to just the text since image was stripped
    expect(session.messages[0].content).toBe('look at this');
  });

  it('load retrieves a saved session by id', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const saved = manager.save('Find Me', messages);

    const loaded = manager.load(saved.id);
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe('Find Me');
    expect(loaded!.messages).toHaveLength(1);
  });

  it('load returns undefined for unknown id', () => {
    expect(manager.load('nonexistent')).toBeUndefined();
  });

  it('update modifies an existing session', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'first' }];
    const saved = manager.save('Updatable', messages);

    const newMessages: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'second' },
    ];
    const result = manager.update(saved.id, newMessages);
    expect(result).toBe(true);

    const loaded = manager.load(saved.id);
    expect(loaded!.messages).toHaveLength(3);
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);
  });

  it('update returns false for unknown id', () => {
    expect(manager.update('nonexistent', [])).toBe(false);
  });

  it('update preserves structured content blocks', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'init' }];
    const saved = manager.save('Structured', messages);

    const updated: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'analyzing...' },
          { type: 'text', text: 'here is my answer' },
        ],
      },
    ];
    manager.update(saved.id, updated);

    const loaded = manager.load(saved.id);
    const content = loaded!.messages[0].content as Array<{ type: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((b) => b.type === 'thinking')).toBe(true);
  });

  it('delete removes a session', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'ephemeral' }];
    const saved = manager.save('Delete Me', messages);

    manager.delete(saved.id);
    expect(manager.load(saved.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
  });

  it('delete is a no-op for unknown id', () => {
    manager.save('Keep Me', [{ role: 'user', content: 'stay' }]);
    manager.delete('nonexistent');
    expect(manager.list()).toHaveLength(1);
  });

  it('saves and lists multiple sessions', () => {
    manager.save('Chat 1', [{ role: 'user', content: 'one' }]);
    manager.save('Chat 2', [{ role: 'user', content: 'two' }]);
    manager.save('Chat 3', [{ role: 'user', content: 'three' }]);

    const all = manager.list();
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.name)).toEqual(['Chat 1', 'Chat 2', 'Chat 3']);
  });
});
