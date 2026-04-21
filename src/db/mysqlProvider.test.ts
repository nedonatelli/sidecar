import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock mysql2/promise
// ---------------------------------------------------------------------------

interface MockConnection {
  query: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

let mockConn: MockConnection;

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: vi.fn(async function () {
      return mockConn;
    }),
  },
  createConnection: vi.fn(async function () {
    return mockConn;
  }),
}));

import { MysqlProvider } from './mysqlProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mysql-test',
    name: 'Test MySQL',
    dialect: 'mysql' as const,
    host: 'localhost',
    port: 3306,
    database: 'testdb',
    user: 'tester',
    readOnly: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MysqlProvider', () => {
  beforeEach(() => {
    mockConn = {
      query: vi.fn().mockResolvedValue([[], []]),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };
  });

  // ---- connect / disconnect ------------------------------------------------

  it('connects and marks as connected', async () => {
    const provider = new MysqlProvider();
    expect(provider.isConnected()).toBe(false);
    await provider.connect(makeProfile());
    expect(provider.isConnected()).toBe(true);
  });

  it('sets read-only transaction on connect when readOnly=true', async () => {
    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: true }));
    const calls = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls as Array<[unknown, ...unknown[]]>;
    const roCall = calls.find(([sql]) => typeof sql === 'string' && (sql as string).includes('TRANSACTION READ ONLY'));
    expect(roCall).toBeDefined();
  });

  it('does NOT set read-only on connect when readOnly=false', async () => {
    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false }));
    const calls = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls as Array<[unknown]>;
    const roCall = calls.find(([sql]) => typeof sql === 'string' && (sql as string).includes('TRANSACTION READ ONLY'));
    expect(roCall).toBeUndefined();
  });

  it('disconnect calls conn.end and sets isConnected to false', async () => {
    const provider = new MysqlProvider();
    await provider.connect(makeProfile());
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(mockConn.end).toHaveBeenCalledTimes(1);
  });

  it('disconnect is a no-op if never connected', async () => {
    const provider = new MysqlProvider();
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });

  // ---- listTables ----------------------------------------------------------

  it('listTables returns TableInfo[] from information_schema', async () => {
    const infoRows = [
      { TABLE_NAME: 'products', TABLE_ROWS: 150 },
      { TABLE_NAME: 'categories', TABLE_ROWS: 20 },
    ];
    const fields = [{ name: 'TABLE_NAME' }, { name: 'TABLE_ROWS' }];

    mockConn = {
      query: vi.fn(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('information_schema.TABLES')) return [infoRows, fields];
        return [[], []];
      }),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const tables = await provider.listTables('testdb');

    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ name: 'products', schema: 'testdb', rowCount: 150 });
    expect(tables[1]).toMatchObject({ name: 'categories', schema: 'testdb', rowCount: 20 });
  });

  it('listTables defaults to the connection database', async () => {
    mockConn = {
      query: vi.fn().mockResolvedValue([[], []]),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false, database: 'myapp' }));

    await provider.listTables();

    const calls = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown[]]>;
    const infoCall = calls.find(([sql]) => typeof sql === 'string' && sql.includes('information_schema.TABLES'));
    expect(infoCall).toBeDefined();
    expect(infoCall![1]).toContain('myapp');
  });

  it('listTables throws when no schema is available', async () => {
    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false, database: undefined }));

    await expect(provider.listTables()).rejects.toThrow('schema');
  });

  // ---- describeTable -------------------------------------------------------

  it('describeTable maps DESCRIBE results to ColumnInfo[]', async () => {
    const descRows = [
      { Field: 'id', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment' },
      { Field: 'email', Type: 'varchar(255)', Null: 'YES', Key: '', Default: null, Extra: '' },
      { Field: 'org_id', Type: 'int(11)', Null: 'NO', Key: 'MUL', Default: null, Extra: '' },
    ];
    const idxRows = [
      { Table: 'users', Non_unique: 0, Key_name: 'PRIMARY', Column_name: 'id', Index_type: 'BTREE' },
      { Table: 'users', Non_unique: 1, Key_name: 'idx_org_id', Column_name: 'org_id', Index_type: 'BTREE' },
    ];
    const fkRows = [{ COLUMN_NAME: 'org_id', REFERENCED_TABLE_NAME: 'organizations', REFERENCED_COLUMN_NAME: 'id' }];

    mockConn = {
      query: vi.fn(async (sql: string) => {
        if (typeof sql === 'string') {
          if (sql.startsWith('DESCRIBE')) return [descRows, []];
          if (sql.startsWith('SHOW INDEXES')) return [idxRows, []];
          if (sql.includes('KEY_COLUMN_USAGE')) return [fkRows, []];
        }
        return [[], []];
      }),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const schema = await provider.describeTable('users', 'testdb');

    expect(schema.columns).toHaveLength(3);
    expect(schema.columns[0]).toMatchObject({ name: 'id', isPK: true, isFK: false });
    expect(schema.columns[2]).toMatchObject({ name: 'org_id', isPK: false, isFK: true });
    expect(schema.columns[2].references).toMatchObject({ table: 'organizations', column: 'id' });

    expect(schema.indexes).toContain('UNIQUE INDEX PRIMARY');
    expect(schema.indexes).toContain('INDEX idx_org_id');

    expect(schema.constraints).toContain('PRIMARY KEY (id)');
  });

  // ---- query ---------------------------------------------------------------

  it('query returns QueryResult with correct shape', async () => {
    const rows = [
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Gadget' },
    ];
    const fields = [{ name: 'id' }, { name: 'name' }];

    mockConn = {
      query: vi.fn(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SET SESSION')) return [[], []];
        return [rows, fields];
      }),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const result = await provider.query('SELECT id, name FROM products');

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('query truncates results when row count exceeds limit', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
    const fields = [{ name: 'id' }];

    mockConn = {
      query: vi.fn().mockResolvedValue([rows, fields]),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const result = await provider.query('SELECT id FROM t', [], { limit: 15 });

    expect(result.rows).toHaveLength(15);
    expect(result.truncated).toBe(true);
  });

  it('query enforces read-only by blocking DELETE', async () => {
    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: true }));

    await expect(provider.query('DELETE FROM products WHERE id = ?', [1])).rejects.toThrow('Read-only violation');
  });

  it('query normalises null values in result rows', async () => {
    const rows = [{ id: 1, description: null }];
    const fields = [{ name: 'id' }, { name: 'description' }];

    mockConn = {
      query: vi.fn().mockResolvedValue([rows, fields]),
      execute: vi.fn().mockResolvedValue([[], []]),
      end: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MysqlProvider();
    await provider.connect(makeProfile({ readOnly: false }));

    const result = await provider.query('SELECT id, description FROM t');

    expect(result.rows[0]['description']).toBeNull();
  });

  it('query throws when not connected', async () => {
    const provider = new MysqlProvider();
    await expect(provider.query('SELECT 1')).rejects.toThrow('not connected');
  });
});
