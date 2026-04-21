import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertReadOnly } from './provider.js';

// ---------------------------------------------------------------------------
// Mock better-sqlite3
// ---------------------------------------------------------------------------

interface MockStatement {
  all: ReturnType<typeof vi.fn>;
}

interface MockDatabase {
  prepare: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockDb: MockDatabase;

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function (this: unknown) {
    return mockDb;
  }),
}));

import { SqliteProvider } from './sqliteProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test',
    name: 'Test SQLite',
    dialect: 'sqlite' as const,
    filePath: '/tmp/test.db',
    readOnly: true,
    ...overrides,
  };
}

function setupSimpleDb(statementResults: Map<string, unknown[]>): void {
  mockDb = {
    prepare: vi.fn((sql: string): MockStatement => {
      const rows = statementResults.get(sql) ?? [];
      return { all: vi.fn(() => rows) };
    }),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// assertReadOnly (exported from provider.ts, exercised here as a sanity check)
// ---------------------------------------------------------------------------

describe('assertReadOnly', () => {
  it('allows SELECT statements', () => {
    expect(() => assertReadOnly('SELECT * FROM users')).not.toThrow();
    expect(() => assertReadOnly('  select id from orders where id=1')).not.toThrow();
  });

  it('allows WITH ... SELECT (CTE)', () => {
    expect(() => assertReadOnly('WITH cte AS (SELECT 1) SELECT * FROM cte')).not.toThrow();
  });

  it('blocks INSERT', () => {
    expect(() => assertReadOnly('INSERT INTO users (name) VALUES (?)')).toThrow('Read-only violation');
  });

  it('blocks UPDATE', () => {
    expect(() => assertReadOnly('UPDATE users SET name=? WHERE id=1')).toThrow('Read-only violation');
  });

  it('blocks DELETE', () => {
    expect(() => assertReadOnly('DELETE FROM users WHERE id=1')).toThrow('Read-only violation');
  });

  it('blocks DROP', () => {
    expect(() => assertReadOnly('DROP TABLE users')).toThrow('Read-only violation');
  });

  it('blocks ALTER', () => {
    expect(() => assertReadOnly('ALTER TABLE users ADD COLUMN email TEXT')).toThrow('Read-only violation');
  });

  it('blocks CREATE', () => {
    expect(() => assertReadOnly('CREATE TABLE foo (id INT)')).toThrow('Read-only violation');
  });

  it('blocks TRUNCATE', () => {
    expect(() => assertReadOnly('TRUNCATE TABLE users')).toThrow('Read-only violation');
  });

  it('blocks GRANT', () => {
    expect(() => assertReadOnly('GRANT SELECT ON users TO admin')).toThrow('Read-only violation');
  });

  it('blocks REVOKE', () => {
    expect(() => assertReadOnly('REVOKE SELECT ON users FROM guest')).toThrow('Read-only violation');
  });

  it('ignores write keywords inside -- comments', () => {
    expect(() => assertReadOnly('SELECT id -- INSERT ignored\nFROM users')).not.toThrow();
  });

  it('ignores write keywords inside /* */ block comments', () => {
    expect(() => assertReadOnly('SELECT id /* UPDATE ignored */ FROM users')).not.toThrow();
  });

  it('catches the second statement in a multi-statement SQL string', () => {
    expect(() => assertReadOnly('SELECT 1; INSERT INTO users VALUES (1)')).toThrow('Read-only violation');
  });

  it('is case-insensitive', () => {
    expect(() => assertReadOnly('insert into foo values (1)')).toThrow('Read-only violation');
    expect(() => assertReadOnly('Insert Into foo Values (1)')).toThrow('Read-only violation');
  });

  it('does not block column names that start with a write keyword prefix', () => {
    // "inserts_count" does not start with "INSERT " (word boundary)
    expect(() => assertReadOnly('SELECT inserts_count FROM stats')).not.toThrow();
    expect(() => assertReadOnly('SELECT drop_reason FROM events')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SqliteProvider unit tests
// ---------------------------------------------------------------------------

describe('SqliteProvider', () => {
  beforeEach(() => {
    setupSimpleDb(new Map());
  });

  // ---- connect / disconnect ------------------------------------------------

  it('connects and marks as connected', async () => {
    setupSimpleDb(new Map());
    const provider = new SqliteProvider();
    expect(provider.isConnected()).toBe(false);
    await provider.connect(makeProfile());
    expect(provider.isConnected()).toBe(true);
  });

  it('throws if filePath is missing', async () => {
    setupSimpleDb(new Map());
    const provider = new SqliteProvider();
    await expect(provider.connect(makeProfile({ filePath: undefined }))).rejects.toThrow('filePath');
  });

  it('disconnect sets isConnected to false', async () => {
    setupSimpleDb(new Map());
    const provider = new SqliteProvider();
    await provider.connect(makeProfile());
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(mockDb.close).toHaveBeenCalledTimes(1);
  });

  it('disconnect is a no-op if never connected', async () => {
    setupSimpleDb(new Map());
    const provider = new SqliteProvider();
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });

  // ---- listTables ----------------------------------------------------------

  it('listTables returns correct TableInfo[] from mocked sqlite_master results', async () => {
    const masterRows = [{ name: 'users' }, { name: 'orders' }];
    const usersCountRows = [{ cnt: 42 }];
    const ordersCountRows = [{ cnt: 7 }];

    mockDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) return { all: vi.fn(() => masterRows) };
        if (sql.includes('"users"')) return { all: vi.fn(() => usersCountRows) };
        if (sql.includes('"orders"')) return { all: vi.fn(() => ordersCountRows) };
        return { all: vi.fn(() => []) };
      }),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile());

    const tables = await provider.listTables();

    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ name: 'users', schema: '', rowCount: 42 });
    expect(tables[1]).toMatchObject({ name: 'orders', schema: '', rowCount: 7 });
  });

  it('listTables handles rowCount failure gracefully (undefined, not throw)', async () => {
    const masterRows = [{ name: 'broken_table' }];

    mockDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) return { all: vi.fn(() => masterRows) };
        // COUNT(*) throws
        return {
          all: vi.fn(() => {
            throw new Error('table broken_table is corrupt');
          }),
        };
      }),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile());

    const tables = await provider.listTables();
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBeUndefined();
  });

  // ---- describeTable -------------------------------------------------------

  it('correctly maps PRAGMA table_info results to ColumnInfo[]', async () => {
    const pragmaTableInfo = [
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 2, name: 'user_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ];
    const pragmaIndexList = [
      { seq: 0, name: 'idx_name', unique: 0, origin: 'c', partial: 0 },
      { seq: 1, name: 'idx_user_id_unique', unique: 1, origin: 'c', partial: 0 },
    ];
    const pragmaFkList = [
      {
        id: 0,
        seq: 0,
        table: 'users',
        from: 'user_id',
        to: 'id',
        on_update: 'NO ACTION',
        on_delete: 'CASCADE',
        match: 'NONE',
      },
    ];

    mockDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('PRAGMA table_info')) return { all: vi.fn(() => pragmaTableInfo) };
        if (sql.includes('PRAGMA index_list')) return { all: vi.fn(() => pragmaIndexList) };
        if (sql.includes('PRAGMA foreign_key_list')) return { all: vi.fn(() => pragmaFkList) };
        // COUNT(*)
        return { all: vi.fn(() => [{ cnt: 10 }]) };
      }),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile());

    const schema = await provider.describeTable('orders');

    // Columns
    expect(schema.columns).toHaveLength(3);
    expect(schema.columns[0]).toMatchObject({ name: 'id', type: 'INTEGER', nullable: false, isPK: true, isFK: false });
    expect(schema.columns[1]).toMatchObject({ name: 'name', type: 'TEXT', nullable: true, isPK: false, isFK: false });
    expect(schema.columns[2]).toMatchObject({ name: 'user_id', type: 'INTEGER', isPK: false, isFK: true });
    expect(schema.columns[2].references).toEqual({ table: 'users', column: 'id' });

    // Indexes
    expect(schema.indexes).toContain('INDEX idx_name');
    expect(schema.indexes).toContain('UNIQUE INDEX idx_user_id_unique');

    // Constraints
    expect(schema.constraints).toContain('PRIMARY KEY (id)');
    expect(schema.constraints).toContain('FOREIGN KEY (user_id) REFERENCES users(id)');
  });

  // ---- query ---------------------------------------------------------------

  it('query returns QueryResult with correct shape', async () => {
    const dbRows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];

    mockDb = {
      prepare: vi.fn(() => ({ all: vi.fn(() => dbRows) })),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile());

    const result = await provider.query('SELECT id, name FROM users');

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows[0]).toEqual({ id: 1, name: 'Alice' });
  });

  it('query truncates when rowCount exceeds limit', async () => {
    const dbRows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));

    mockDb = {
      prepare: vi.fn(() => ({ all: vi.fn(() => dbRows) })),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile());

    const result = await provider.query('SELECT id FROM users', [], { limit: 5 });

    expect(result.rows).toHaveLength(5);
    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('query converts BigInt values to numbers', async () => {
    const dbRows = [{ id: BigInt(9999999999999), count: BigInt(1) }];

    mockDb = {
      prepare: vi.fn(() => ({ all: vi.fn(() => dbRows) })),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile());

    const result = await provider.query('SELECT id, count FROM metrics');

    expect(typeof result.rows[0]['id']).toBe('number');
    expect(typeof result.rows[0]['count']).toBe('number');
  });

  it('query throws Read-only violation for INSERT on read-only connection', async () => {
    mockDb = {
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile({ readOnly: true }));

    await expect(provider.query('INSERT INTO users (name) VALUES (?)', ['Eve'])).rejects.toThrow('Read-only violation');
  });

  it('query allows INSERT on a non-read-only connection', async () => {
    const dbRows = [{ changes: 1 }];

    mockDb = {
      prepare: vi.fn(() => ({ all: vi.fn(() => dbRows) })),
      close: vi.fn(),
    };

    const provider = new SqliteProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const result = await provider.query('INSERT INTO users (name) VALUES (?)', ['Eve']);
    expect(result.rowCount).toBe(1);
  });

  it('query throws when not connected', async () => {
    const provider = new SqliteProvider();
    await expect(provider.query('SELECT 1')).rejects.toThrow('not connected');
  });
});
