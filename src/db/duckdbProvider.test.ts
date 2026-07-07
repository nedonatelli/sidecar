import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @duckdb/node-api (an optional devDependency). The provider's flow is:
//   DuckDBInstance.create(path) -> instance.connect() -> conn.run(sql)
//   -> result.columnNames() + result.getRows()
// A single router maps each SQL string to { columns, rows } so tests declare
// exactly what each information_schema / duckdb_* / COUNT(*) / user query returns.
// ---------------------------------------------------------------------------

type DuckRows = Record<string, unknown>[];
type DuckReply = { columns: string[]; rows: DuckRows };

const mock = vi.hoisted(() => {
  const state: { route: (sql: string) => DuckReply } = { route: () => ({ columns: [], rows: [] }) };
  const conn = {
    run: vi.fn(async (sql: string) => {
      const r = state.route(sql);
      return { columnNames: () => r.columns, getRows: async () => r.rows };
    }),
    close: vi.fn(),
  };
  const instance = { connect: vi.fn(async () => conn) };
  const create = vi.fn(async () => instance);
  return { state, conn, instance, create };
});

vi.mock('@duckdb/node-api', () => ({ DuckDBInstance: { create: mock.create } }));

import { DuckDbProvider } from './duckdbProvider.js';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test',
    name: 'Test DuckDB',
    dialect: 'duckdb' as const,
    filePath: '/tmp/test.duckdb',
    readOnly: true,
    ...overrides,
  };
}

/** Route by matching the first substring key found in the SQL. */
function routeBy(map: Array<[string, DuckReply]>, fallback: DuckReply = { columns: [], rows: [] }) {
  mock.state.route = (sql: string) => {
    for (const [needle, reply] of map) if (sql.includes(needle)) return reply;
    return fallback;
  };
}

async function connected(profile = makeProfile()): Promise<DuckDbProvider> {
  const p = new DuckDbProvider();
  await p.connect(profile);
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.state.route = () => ({ columns: [], rows: [] });
});

describe('DuckDbProvider — connect / disconnect', () => {
  it('connects and marks as connected', async () => {
    const p = new DuckDbProvider();
    expect(p.isConnected()).toBe(false);
    await p.connect(makeProfile());
    expect(p.isConnected()).toBe(true);
    expect(mock.create).toHaveBeenCalledWith('/tmp/test.duckdb');
  });

  it('defaults to an in-memory database when no filePath is given', async () => {
    await connected(makeProfile({ filePath: undefined }));
    expect(mock.create).toHaveBeenCalledWith(':memory:');
  });

  it('runs SET access_mode = READ_ONLY on a read-only connection', async () => {
    await connected(makeProfile({ readOnly: true }));
    const ranSet = mock.conn.run.mock.calls.some(([sql]) => (sql as string).includes('access_mode = READ_ONLY'));
    expect(ranSet).toBe(true);
  });

  it('swallows a SET access_mode failure (older DuckDB / in-memory)', async () => {
    mock.conn.run.mockImplementationOnce(async () => {
      throw new Error('SET not supported');
    });
    // Should not reject despite the SET throwing.
    await expect(connected(makeProfile({ readOnly: true }))).resolves.toBeInstanceOf(DuckDbProvider);
  });

  it('does not set read-only mode on a writable connection', async () => {
    await connected(makeProfile({ readOnly: false }));
    const ranSet = mock.conn.run.mock.calls.some(([sql]) => (sql as string).includes('access_mode'));
    expect(ranSet).toBe(false);
  });

  it('disconnect closes the connection and marks disconnected', async () => {
    const p = await connected();
    await p.disconnect();
    expect(p.isConnected()).toBe(false);
    expect(mock.conn.close).toHaveBeenCalledTimes(1);
  });

  it('disconnect is a no-op when never connected', async () => {
    const p = new DuckDbProvider();
    await expect(p.disconnect()).resolves.toBeUndefined();
    expect(mock.conn.close).not.toHaveBeenCalled();
  });
});

describe('DuckDbProvider — listTables', () => {
  it('maps information_schema.tables rows with per-table row counts', async () => {
    routeBy([
      ['information_schema.tables', { columns: [], rows: [{ table_name: 'users', table_schema: 'main' }] }],
      ['"users"', { columns: ['cnt'], rows: [{ cnt: 42 }] }],
    ]);
    const p = await connected();
    const tables = await p.listTables();
    expect(tables).toEqual([{ name: 'users', schema: 'main', rowCount: 42 }]);
  });

  it('leaves rowCount undefined when the COUNT(*) query fails', async () => {
    mock.state.route = (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { columns: [], rows: [{ table_name: 'broken', table_schema: 'main' }] };
      }
      throw new Error('table broken is corrupt');
    };
    const p = await connected();
    const tables = await p.listTables();
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBeUndefined();
  });
});

describe('DuckDbProvider — describeTable', () => {
  it('maps columns, indexes, PK constraints, and approx row count', async () => {
    routeBy([
      [
        'information_schema.columns',
        {
          columns: [],
          rows: [
            { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
            { column_name: 'name', data_type: 'VARCHAR', is_nullable: 'YES', column_default: "'anon'" },
          ],
        },
      ],
      ['duckdb_indexes', { columns: [], rows: [{ index_name: 'idx_name' }] }],
      ['duckdb_constraints', { columns: [], rows: [{ constraint_column_names: ['id'] }] }],
      ['COUNT(*)', { columns: ['cnt'], rows: [{ cnt: 10 }] }],
    ]);
    const p = await connected();
    const schema = await p.describeTable('users');

    expect(schema.columns).toHaveLength(2);
    expect(schema.columns[0]).toMatchObject({ name: 'id', type: 'INTEGER', nullable: false, isPK: true });
    expect(schema.columns[1]).toMatchObject({ name: 'name', type: 'VARCHAR', nullable: true, default: "'anon'" });
    expect(schema.indexes).toEqual(['idx_name']);
    expect(schema.constraints).toEqual(['PRIMARY KEY (id)']);
    expect(schema.approxRowCount).toBe(10);
  });

  it('degrades gracefully when index/constraint introspection throws', async () => {
    mock.state.route = (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return {
          columns: [],
          rows: [{ column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null }],
        };
      }
      if (sql.includes('COUNT(*)')) return { columns: ['cnt'], rows: [{ cnt: 3 }] };
      throw new Error('duckdb_indexes() not available');
    };
    const p = await connected();
    const schema = await p.describeTable('users');
    expect(schema.columns).toHaveLength(1);
    expect(schema.indexes).toEqual([]);
    expect(schema.constraints).toEqual([]);
    expect(schema.approxRowCount).toBe(3);
  });
});

describe('DuckDbProvider — query', () => {
  it('returns a QueryResult with columns, rows, count, and truncated=false', async () => {
    routeBy([
      [
        'SELECT',
        {
          columns: ['id', 'name'],
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        },
      ],
    ]);
    const p = await connected();
    const result = await p.query('SELECT id, name FROM users');
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows[0]).toEqual({ id: 1, name: 'Alice' });
  });

  it('truncates rows beyond the limit but reports the raw count', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    routeBy([['SELECT', { columns: ['id'], rows }]]);
    const p = await connected();
    const result = await p.query('SELECT id FROM users', [], { limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('normalizes BigInt values to numbers and null-coerces undefined', async () => {
    routeBy([['SELECT', { columns: ['id', 'note'], rows: [{ id: BigInt(9007199254740991), note: undefined }] }]]);
    const p = await connected();
    const result = await p.query('SELECT id, note FROM metrics');
    expect(typeof result.rows[0]['id']).toBe('number');
    expect(result.rows[0]['note']).toBeNull();
  });

  it('blocks a write on a read-only connection', async () => {
    const p = await connected(makeProfile({ readOnly: true }));
    await expect(p.query('INSERT INTO users VALUES (1)')).rejects.toThrow('Read-only violation');
  });

  it('allows a write on a writable connection', async () => {
    routeBy([['INSERT', { columns: [], rows: [] }]]);
    const p = await connected(makeProfile({ readOnly: false }));
    const result = await p.query('INSERT INTO users VALUES (1)');
    expect(result.rowCount).toBe(0);
  });

  it('throws when the provider is not connected', async () => {
    const p = new DuckDbProvider();
    await expect(p.query('SELECT 1')).rejects.toThrow('not connected');
  });
});
