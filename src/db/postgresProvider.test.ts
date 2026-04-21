import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pg — Pool is a constructor that returns the current mockPool value.
// ---------------------------------------------------------------------------

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

let mockPool: MockPool;

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function (this: unknown) {
      return mockPool;
    }),
  },
  Pool: vi.fn(function (this: unknown) {
    return mockPool;
  }),
}));

import { PostgresProvider } from './postgresProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pg-test',
    name: 'Test Postgres',
    dialect: 'postgres' as const,
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    user: 'tester',
    readOnly: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresProvider', () => {
  beforeEach(() => {
    // Default pool that accepts SET SESSION and returns nothing else
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
  });

  // ---- connect / disconnect ------------------------------------------------

  it('connects and marks as connected', async () => {
    const provider = new PostgresProvider();
    expect(provider.isConnected()).toBe(false);
    await provider.connect(makeProfile());
    expect(provider.isConnected()).toBe(true);
  });

  it('sets read-only transaction characteristic on connect when readOnly=true', async () => {
    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: true }));
    expect(mockPool.query).toHaveBeenCalledWith('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  });

  it('does NOT set read-only on connect when readOnly=false', async () => {
    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));
    expect(mockPool.query).not.toHaveBeenCalledWith('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  });

  it('disconnect calls pool.end and sets isConnected to false', async () => {
    const provider = new PostgresProvider();
    await provider.connect(makeProfile());
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it('disconnect is a no-op if never connected', async () => {
    const provider = new PostgresProvider();
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });

  // ---- listTables ----------------------------------------------------------

  it('listTables returns TableInfo[] with row counts', async () => {
    const tablesRows = [
      { table_name: 'users', table_schema: 'public' },
      { table_name: 'orders', table_schema: 'public' },
    ];

    mockPool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: tablesRows, fields: [] };
        }
        if (sql.includes('pg_class') && Array.isArray(params) && params.includes('users')) {
          return { rows: [{ reltuples: 100 }], fields: [] };
        }
        if (sql.includes('pg_class') && Array.isArray(params) && params.includes('orders')) {
          return { rows: [{ reltuples: 55 }], fields: [] };
        }
        return { rows: [], fields: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const tables = await provider.listTables('public');

    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ name: 'users', schema: 'public', rowCount: 100 });
    expect(tables[1]).toMatchObject({ name: 'orders', schema: 'public', rowCount: 55 });
  });

  it('listTables defaults to public schema', async () => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    await provider.listTables();

    const calls = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown[]]>;
    const infoSchemaCall = calls.find(([sql]) => sql.includes('information_schema.tables'));
    expect(infoSchemaCall).toBeDefined();
    expect(infoSchemaCall![1]).toContain('public');
  });

  // ---- describeTable -------------------------------------------------------

  it('describeTable returns columns with PK and FK flags', async () => {
    const colRows = [
      { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
      { column_name: 'user_id', data_type: 'integer', is_nullable: 'YES', column_default: null },
      { column_name: 'email', data_type: 'text', is_nullable: 'YES', column_default: null },
    ];
    const pkRows = [{ column_name: 'id', constraint_name: 'orders_pkey' }];
    const fkRows = [{ column_name: 'user_id', table_name: 'users', constraint_name: 'fk_user' }];
    const idxRows = [{ indexname: 'orders_pkey', indexdef: 'CREATE UNIQUE INDEX orders_pkey ON orders (id)' }];
    const conRows = [
      { constraint_name: 'orders_pkey', constraint_type: 'PRIMARY KEY' },
      { constraint_name: 'fk_user', constraint_type: 'FOREIGN KEY' },
    ];
    const pgClassRows = [{ reltuples: 200 }];

    mockPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.columns')) return { rows: colRows, fields: [] };
        if (sql.includes('FOREIGN KEY')) return { rows: fkRows, fields: [] };
        if (sql.includes('PRIMARY KEY')) return { rows: pkRows, fields: [] };
        if (sql.includes('pg_indexes')) return { rows: idxRows, fields: [] };
        if (sql.includes('table_constraints')) return { rows: conRows, fields: [] };
        if (sql.includes('pg_class')) return { rows: pgClassRows, fields: [] };
        return { rows: [], fields: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const schema = await provider.describeTable('orders', 'public');

    expect(schema.columns).toHaveLength(3);
    expect(schema.columns[0]).toMatchObject({ name: 'id', isPK: true, isFK: false });
    expect(schema.columns[1]).toMatchObject({ name: 'user_id', isPK: false, isFK: true });
    expect(schema.columns[1].references).toMatchObject({ table: 'users' });
    expect(schema.columns[2]).toMatchObject({ name: 'email', isPK: false, isFK: false });

    expect(schema.indexes).toContain('CREATE UNIQUE INDEX orders_pkey ON orders (id)');
    expect(schema.constraints).toContain('PRIMARY KEY orders_pkey');
    expect(schema.approxRowCount).toBe(200);
  });

  // ---- query ---------------------------------------------------------------

  it('query returns QueryResult with columns from fields', async () => {
    mockPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SET SESSION')) return { rows: [], fields: [] };
        return {
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
          fields: [{ name: 'id' }, { name: 'name' }],
        };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const result = await provider.query('SELECT id, name FROM users');

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('query truncates results when rowCount > limit', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows, fields: [{ name: 'id' }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const result = await provider.query('SELECT id FROM t', [], { limit: 10 });

    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it('query enforces read-only by blocking INSERT', async () => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: true }));

    await expect(provider.query('INSERT INTO users VALUES (1)')).rejects.toThrow('Read-only violation');
  });

  it('query sets statement_timeout when timeoutMs provided', async () => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], fields: [] }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new PostgresProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    await provider.query('SELECT 1', [], { timeoutMs: 5000 });

    const calls = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const timeoutCall = calls.find(([sql]) => sql === 'SET statement_timeout = 5000');
    expect(timeoutCall).toBeDefined();
  });

  it('query throws when not connected', async () => {
    const provider = new PostgresProvider();
    await expect(provider.query('SELECT 1')).rejects.toThrow('not connected');
  });
});
