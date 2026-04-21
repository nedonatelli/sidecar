import { describe, it, expect } from 'vitest';
import {
  parseBacklog,
  nextPendingItem,
  markItemDone,
  markItemPending,
  backlogStats,
  appendItem,
  parseItemSentinels,
  stripSentinels,
} from './backlogParser.js';

const SAMPLE = `# My Backlog

- [ ] Add unit tests for auth module
- [x] Fix login redirect bug
- [ ] Refactor database connection pool
- [ ] Update README with setup instructions
`;

describe('parseBacklog', () => {
  it('returns all checklist items', () => {
    const items = parseBacklog(SAMPLE);
    expect(items).toHaveLength(4);
  });

  it('correctly identifies done vs pending', () => {
    const items = parseBacklog(SAMPLE);
    expect(items[0].done).toBe(false);
    expect(items[1].done).toBe(true);
    expect(items[2].done).toBe(false);
  });

  it('strips the checkbox prefix from text', () => {
    const items = parseBacklog(SAMPLE);
    expect(items[0].text).toBe('Add unit tests for auth module');
    expect(items[1].text).toBe('Fix login redirect bug');
  });

  it('records the correct lineIndex', () => {
    const items = parseBacklog(SAMPLE);
    expect(items[0].lineIndex).toBe(2); // 0=blank heading line, 1=blank, 2=first item
  });

  it('returns empty array for empty content', () => {
    expect(parseBacklog('')).toHaveLength(0);
  });

  it('ignores non-checklist lines', () => {
    const content = '# Heading\n\nSome prose\n\n- [ ] Task one\n';
    expect(parseBacklog(content)).toHaveLength(1);
  });

  it('handles uppercase X in done items', () => {
    const content = '- [X] Done task\n';
    const items = parseBacklog(content);
    expect(items[0].done).toBe(true);
  });

  it('handles indented checklist items', () => {
    const content = '  - [ ] Indented task\n';
    const items = parseBacklog(content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Indented task');
  });
});

describe('nextPendingItem', () => {
  it('returns the first unchecked item', () => {
    const items = parseBacklog(SAMPLE);
    const next = nextPendingItem(items);
    expect(next?.text).toBe('Add unit tests for auth module');
  });

  it('skips done items', () => {
    const content = '- [x] Done\n- [ ] Pending\n';
    const items = parseBacklog(content);
    expect(nextPendingItem(items)?.text).toBe('Pending');
  });

  it('returns undefined when all items are done', () => {
    const content = '- [x] A\n- [x] B\n';
    expect(nextPendingItem(parseBacklog(content))).toBeUndefined();
  });

  it('returns undefined for empty backlog', () => {
    expect(nextPendingItem([])).toBeUndefined();
  });
});

describe('markItemDone', () => {
  it('converts [ ] to [x] at the given line', () => {
    const items = parseBacklog(SAMPLE);
    const updated = markItemDone(SAMPLE, items[0].lineIndex);
    const reparsed = parseBacklog(updated);
    expect(reparsed[0].done).toBe(true);
  });

  it('leaves other lines unchanged', () => {
    const items = parseBacklog(SAMPLE);
    const updated = markItemDone(SAMPLE, items[0].lineIndex);
    const reparsed = parseBacklog(updated);
    // item 1 was already done — still done
    expect(reparsed[1].done).toBe(true);
    // item 2 was pending — still pending
    expect(reparsed[2].done).toBe(false);
  });

  it('is idempotent on already-done items', () => {
    const items = parseBacklog(SAMPLE);
    const once = markItemDone(SAMPLE, items[1].lineIndex); // already [x]
    const twice = markItemDone(once, items[1].lineIndex);
    expect(once).toBe(twice);
  });
});

describe('markItemPending', () => {
  it('converts [x] back to [ ]', () => {
    const items = parseBacklog(SAMPLE);
    const updated = markItemPending(SAMPLE, items[1].lineIndex);
    const reparsed = parseBacklog(updated);
    expect(reparsed[1].done).toBe(false);
  });
});

describe('backlogStats', () => {
  it('counts total, done, and pending correctly', () => {
    const stats = backlogStats(parseBacklog(SAMPLE));
    expect(stats.total).toBe(4);
    expect(stats.done).toBe(1);
    expect(stats.pending).toBe(3);
  });

  it('handles all-done backlog', () => {
    const stats = backlogStats(parseBacklog('- [x] A\n- [x] B\n'));
    expect(stats.pending).toBe(0);
    expect(stats.done).toBe(2);
  });

  it('handles empty backlog', () => {
    const stats = backlogStats([]);
    expect(stats.total).toBe(0);
    expect(stats.done).toBe(0);
    expect(stats.pending).toBe(0);
  });
});

describe('appendItem', () => {
  it('adds a new pending item at the end', () => {
    const updated = appendItem(SAMPLE, 'New task');
    const items = parseBacklog(updated);
    expect(items[items.length - 1].text).toBe('New task');
    expect(items[items.length - 1].done).toBe(false);
  });

  it('handles content without trailing newline', () => {
    const content = '- [ ] Existing';
    const updated = appendItem(content, 'New task');
    expect(updated).toBe('- [ ] Existing\n- [ ] New task\n');
  });
});

describe('parseItemSentinels', () => {
  it('parses @model: sentinel', () => {
    const s = parseItemSentinels('Refactor auth @model:claude-opus-4-7');
    expect(s.model).toBe('claude-opus-4-7');
  });

  it('parses @shadowMode: sentinel with valid values', () => {
    expect(parseItemSentinels('Task @shadowMode:always').shadowMode).toBe('always');
    expect(parseItemSentinels('Task @shadowMode:off').shadowMode).toBe('off');
    expect(parseItemSentinels('Task @shadowMode:opt-in').shadowMode).toBe('opt-in');
  });

  it('ignores @shadowMode: with unknown values', () => {
    expect(parseItemSentinels('Task @shadowMode:unknown').shadowMode).toBeUndefined();
  });

  it('parses @facets: as a comma-separated list', () => {
    const s = parseItemSentinels('Task @facets:security,reviewer');
    expect(s.facets).toEqual(['security', 'reviewer']);
  });

  it('parses multiple sentinels on one item', () => {
    const s = parseItemSentinels('Task @model:qwen3:14b @shadowMode:always @facets:docs');
    expect(s.model).toBe('qwen3:14b');
    expect(s.shadowMode).toBe('always');
    expect(s.facets).toEqual(['docs']);
  });

  it('returns empty object when no sentinels present', () => {
    expect(parseItemSentinels('Plain task text')).toEqual({});
  });
});

describe('stripSentinels', () => {
  it('removes sentinel tokens from text', () => {
    expect(stripSentinels('Refactor auth @model:claude-opus-4-7')).toBe('Refactor auth');
  });

  it('removes multiple sentinels and normalises whitespace', () => {
    expect(stripSentinels('Task @model:x @shadowMode:always @facets:a,b')).toBe('Task');
  });

  it('leaves plain text unchanged', () => {
    expect(stripSentinels('Write unit tests')).toBe('Write unit tests');
  });
});

describe('parseBacklog — sentinel integration', () => {
  it('strips sentinels from item.text and populates item.sentinels', () => {
    const content = '- [ ] Refactor auth @model:qwen3:14b @shadowMode:always\n';
    const [item] = parseBacklog(content);
    expect(item.text).toBe('Refactor auth');
    expect(item.sentinels.model).toBe('qwen3:14b');
    expect(item.sentinels.shadowMode).toBe('always');
  });

  it('populates empty sentinels object for plain items', () => {
    const content = '- [ ] Write tests\n';
    const [item] = parseBacklog(content);
    expect(item.sentinels).toEqual({});
  });
});
