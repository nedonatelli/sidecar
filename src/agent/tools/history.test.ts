import { describe, it, expect, vi, beforeEach } from 'vitest';

// Control the history DB via a hoisted handle.
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../history/historyDb.js', () => ({
  getHistoryDb: vi.fn(() => ({ query: h.query })),
}));

import { queryHistoryTool } from './history.js';

const run = (sql: unknown) => queryHistoryTool.executor({ sql } as Record<string, unknown>);

beforeEach(() => {
  h.query.mockReset();
});

describe('query_history', () => {
  it('requires a sql argument', async () => {
    expect(await run('')).toBe('Error: sql is required.');
    expect(await run(undefined)).toBe('Error: sql is required.');
    expect(h.query).not.toHaveBeenCalled();
  });

  it('returns rows as pretty JSON', async () => {
    h.query.mockReturnValue([{ model: 'qwen3', pct: 96 }]);
    const out = await run('SELECT model, pct FROM eval_runs');
    expect(h.query).toHaveBeenCalledWith('SELECT model, pct FROM eval_runs');
    expect(JSON.parse(out)).toEqual([{ model: 'qwen3', pct: 96 }]);
  });

  it('reports an empty result set', async () => {
    h.query.mockReturnValue([]);
    expect(await run('SELECT * FROM eval_runs WHERE 1=0')).toBe('No results.');
  });

  it('surfaces a DB error (e.g. non-SELECT rejected by the db layer) as a string', async () => {
    h.query.mockImplementation(() => {
      throw new Error('Only SELECT queries are allowed.');
    });
    const out = await run('DROP TABLE eval_runs');
    expect(out).toContain('Error: Only SELECT queries are allowed.');
  });

  it('trims whitespace before dispatching the query', async () => {
    h.query.mockReturnValue([{ n: 1 }]);
    await run('   SELECT 1   ');
    expect(h.query).toHaveBeenCalledWith('SELECT 1');
  });
});
