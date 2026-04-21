import { describe, it, expect } from 'vitest';
import {
  parseBacklog,
  nextPendingItem,
  markItemDone,
  markItemPending,
  backlogStats,
  appendItem,
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
