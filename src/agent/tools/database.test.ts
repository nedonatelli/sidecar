import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    databaseProfiles: [],
    databaseQueryRowLimit: 10000,
    databaseQueryTimeoutMs: 30000,
    agentMode: 'cautious',
  })),
}));

vi.mock('../../db/connectionManager.js', () => ({
  connectionManager: {
    getStatus: vi.fn(() => []),
    getOrConnect: vi.fn(),
  },
}));

vi.mock('../../db/provider.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/provider.js')>('../../db/provider.js');
  return { ...actual };
});

vi.mock('../audit/auditBuffer.js', () => ({
  getDefaultAuditBuffer: vi.fn(() => ({ write: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('./shared.js', async () => {
  const actual = await vi.importActual<typeof import('./shared.js')>('./shared.js');
  return { ...actual, getRoot: vi.fn(() => '/workspace') };
});

import { databaseTools } from './database.js';
import { getConfig } from '../../config/settings.js';
import { connectionManager } from '../../db/connectionManager.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof vi.fn<any>>;

function getExecutor(name: string) {
  const tool = databaseTools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.executor;
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-db',
    name: 'Test DB',
    dialect: 'sqlite',
    filePath: '/data/test.db',
    readOnly: true,
    ...overrides,
  };
}

function makeQueryResult(overrides: Record<string, unknown> = {}) {
  return {
    columns: ['id', 'name'],
    rows: [{ id: 1, name: 'Alice' }],
    rowCount: 1,
    truncated: false,
    ...overrides,
  };
}

describe('databaseTools registry', () => {
  it('exports exactly 6 tools', () => {
    expect(databaseTools).toHaveLength(6);
  });

  it('db_list_connections and db_list_tables do not require approval', () => {
    const noApproval = ['db_list_connections', 'db_list_tables', 'db_describe_table', 'db_query'];
    for (const name of noApproval) {
      const tool = databaseTools.find((t) => t.definition.name === name)!;
      expect(tool.requiresApproval).toBe(false);
    }
  });

  it('db_execute and db_migrate_up require approval', () => {
    for (const name of ['db_execute', 'db_migrate_up']) {
      const tool = databaseTools.find((t) => t.definition.name === name)!;
      expect(tool.requiresApproval).toBe(true);
    }
  });
});

describe('db_list_connections', () => {
  const exec = getExecutor('db_list_connections');

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({ databaseProfiles: [] } as never);
    vi.mocked(connectionManager.getStatus).mockReturnValue([]);
  });

  it('returns "No database profiles configured" message when profiles is empty', async () => {
    const result = await exec({});
    expect(result).toMatch(/No database profiles configured/);
  });

  it('lists each profile with dialect, location, and status', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile({ id: 'db1', name: 'My SQLite', dialect: 'sqlite', filePath: '/data/db.sqlite' })],
    } as never);
    vi.mocked(connectionManager.getStatus).mockReturnValue([
      { id: 'db1', name: 'db1', dialect: 'sqlite', connected: true },
    ]);

    const result = await exec({});
    expect(result).toContain('My SQLite');
    expect(result).toContain('sqlite');
    expect(result).toContain('/data/db.sqlite');
    expect(result).toContain('✓ connected');
  });

  it('shows "○ not connected" for profiles not in status map', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [
        makeProfile({
          id: 'db2',
          name: 'Remote PG',
          dialect: 'postgres',
          host: 'localhost',
          port: 5432,
          database: 'mydb',
        }),
      ],
    } as never);

    const result = await exec({});
    expect(result).toContain('○ not connected');
  });

  it('shows default postgres port (5432) when port is not set', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile({ id: 'db3', dialect: 'postgres', host: 'pg.host', database: 'dev' })],
    } as never);

    const result = await exec({});
    expect(result).toContain('5432');
  });

  it('shows default mysql port (3306)', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile({ id: 'db4', dialect: 'mysql', host: 'mysql.host', database: 'dev' })],
    } as never);

    const result = await exec({});
    expect(result).toContain('3306');
  });
});

describe('db_list_tables', () => {
  const exec = getExecutor('db_list_tables');

  it('returns error when connection_id is missing', async () => {
    expect(await exec({})).toMatch(/connection_id is required/);
  });

  it('returns error when no profile matches the connection_id', async () => {
    vi.mocked(getConfig).mockReturnValue({ databaseProfiles: [] } as never);
    expect(await exec({ connection_id: 'nonexistent' })).toMatch(/no database profile found/);
  });

  it('returns error message when getOrConnect throws', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile()],
    } as never);
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockRejectedValue(new Error('connection refused'));

    const result = await exec({ connection_id: 'test-db' });
    expect(result).toContain('Error connecting');
    expect(result).toContain('connection refused');
  });

  it('returns "No tables found" when provider returns empty list', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile()],
    } as never);
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      listTables: vi.fn().mockResolvedValue([]),
    });

    const result = await exec({ connection_id: 'test-db' });
    expect(result).toMatch(/No tables found/);
  });

  it('lists tables with schema-qualified names and row counts', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile()],
    } as never);
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      listTables: vi.fn().mockResolvedValue([
        { name: 'users', schema: 'public', rowCount: 42 },
        { name: 'orders', schema: undefined, rowCount: undefined },
      ]),
    });

    const result = await exec({ connection_id: 'test-db' });
    expect(result).toContain('public.users');
    expect(result).toContain('~42');
    expect(result).toContain('orders');
  });
});

describe('db_describe_table', () => {
  const exec = getExecutor('db_describe_table');

  it('returns error when connection_id is missing', async () => {
    expect(await exec({})).toMatch(/connection_id is required/);
  });

  it('returns error when table is missing', async () => {
    expect(await exec({ connection_id: 'test-db' })).toMatch(/table is required/);
  });

  it('returns error when no profile matches', async () => {
    vi.mocked(getConfig).mockReturnValue({ databaseProfiles: [] } as never);
    expect(await exec({ connection_id: 'x', table: 'users' })).toMatch(/no database profile found/);
  });

  it('describes columns with PK, FK, nullable, and default info', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile()],
    } as never);
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      describeTable: vi.fn().mockResolvedValue({
        columns: [
          { name: 'id', type: 'INTEGER', isPK: true, isFK: false, nullable: false, default: null },
          {
            name: 'user_id',
            type: 'INTEGER',
            isPK: false,
            isFK: true,
            references: { table: 'users', column: 'id' },
            nullable: false,
            default: null,
          },
          { name: 'note', type: 'TEXT', isPK: false, isFK: false, nullable: true, default: null },
        ],
        indexes: ['idx_user_id'],
        constraints: [],
        approxRowCount: 100,
      }),
    });

    const result = await exec({ connection_id: 'test-db', table: 'orders' });
    expect(result).toContain('id INTEGER');
    expect(result).toContain('PK');
    expect(result).toContain('FK→users.id');
    expect(result).toContain('nullable');
    expect(result).toContain('idx_user_id');
    expect(result).toContain('100');
  });
});

describe('db_query', () => {
  const exec = getExecutor('db_query');

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile()],
      databaseQueryRowLimit: 10000,
      databaseQueryTimeoutMs: 30000,
      agentMode: 'cautious',
    } as never);
  });

  it('returns error when connection_id is missing', async () => {
    expect(await exec({ sql: 'SELECT 1' })).toMatch(/connection_id is required/);
  });

  it('returns error when sql is missing', async () => {
    expect(await exec({ connection_id: 'test-db' })).toMatch(/sql is required/);
  });

  it('returns read-only violation error for write SQL', async () => {
    const result = await exec({ connection_id: 'test-db', sql: 'INSERT INTO t VALUES (1)' });
    expect(result).toMatch(/Read-only violation/);
  });

  it('returns "no rows" message when query returns empty result', async () => {
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      query: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0, truncated: false }),
    });

    const result = await exec({ connection_id: 'test-db', sql: 'SELECT * FROM empty' });
    expect(result).toMatch(/no rows/i);
  });

  it('returns HTML table when query has results', async () => {
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      query: vi.fn().mockResolvedValue(makeQueryResult()),
    });

    const result = await exec({ connection_id: 'test-db', sql: 'SELECT id, name FROM users' });
    expect(result).toContain('<table');
    expect(result).toContain('id');
    expect(result).toContain('name');
    expect(result).toContain('Alice');
  });

  it('shows truncation notice in footer when result is truncated', async () => {
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      query: vi
        .fn()
        .mockResolvedValue(makeQueryResult({ truncated: true, rowCount: 50000, rows: [{ id: 1, name: 'A' }] })),
    });

    const result = await exec({ connection_id: 'test-db', sql: 'SELECT * FROM big' });
    expect(result).toContain('truncated');
    expect(result).toContain('50000');
  });

  it('caps limit at config.databaseQueryRowLimit when input.limit exceeds it', async () => {
    const querySpy = vi.fn().mockResolvedValue(makeQueryResult());
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({ query: querySpy });

    await exec({ connection_id: 'test-db', sql: 'SELECT 1', limit: 999999 });

    const [, , opts] = querySpy.mock.calls[0] as [unknown, unknown, { limit: number }];
    expect(opts.limit).toBe(10000);
  });
});

describe('db_execute', () => {
  const exec = getExecutor('db_execute');

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile({ readOnly: true })],
      agentMode: 'cautious',
    } as never);
  });

  it('returns error when connection_id is missing', async () => {
    expect(await exec({ sql: 'INSERT INTO t VALUES (1)' })).toMatch(/connection_id is required/);
  });

  it('returns error when sql is missing', async () => {
    expect(await exec({ connection_id: 'test-db' })).toMatch(/sql is required/);
  });

  it('returns error for read-only connection profiles', async () => {
    const result = await exec({ connection_id: 'test-db', sql: 'INSERT INTO t VALUES (1)' });
    expect(result).toContain('read-only');
  });

  it('buffers the SQL in audit mode instead of executing', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile({ readOnly: false })],
      agentMode: 'audit',
    } as never);
    const writeStub = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getDefaultAuditBuffer).mockReturnValue({ write: writeStub } as never);

    const result = await exec({ connection_id: 'test-db', sql: 'DELETE FROM logs' });
    expect(writeStub).toHaveBeenCalledOnce();
    expect(result).toContain('buffered for audit review');
  });

  it('executes the statement and returns rows affected when successful', async () => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile({ readOnly: false })],
      agentMode: 'cautious',
    } as never);
    (vi.mocked(connectionManager.getOrConnect) as AnyMock).mockResolvedValue({
      query: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 3, truncated: false }),
    });

    const result = await exec({ connection_id: 'test-db', sql: 'DELETE FROM logs WHERE old=1' });
    expect(result).toContain('3');
    expect(result).toContain('Rows affected');
  });
});

describe('db_migrate_up', () => {
  const exec = getExecutor('db_migrate_up');

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      databaseProfiles: [makeProfile()],
    } as never);
  });

  it('returns error when connection_id is missing', async () => {
    expect(await exec({})).toMatch(/connection_id is required/);
  });

  it('returns error when no profile matches', async () => {
    vi.mocked(getConfig).mockReturnValue({ databaseProfiles: [] } as never);
    expect(await exec({ connection_id: 'x' })).toMatch(/no database profile found/);
  });

  it('dry_run shows the command without executing', async () => {
    const result = await exec({ connection_id: 'test-db', tool: 'prisma', dry_run: true });
    expect(result).toContain('dry-run');
    expect(result).toContain('prisma');
    expect(result).toContain('not executed');
  });

  it('dry_run for alembic shows alembic command', async () => {
    const result = await exec({
      connection_id: 'test-db',
      tool: 'alembic',
      migration_dir: 'migrations',
      dry_run: true,
    });
    expect(result).toContain('alembic');
    expect(result).toContain('upgrade head');
  });

  it('dry_run for flyway shows flyway command', async () => {
    const result = await exec({ connection_id: 'test-db', tool: 'flyway', dry_run: true });
    expect(result).toContain('flyway');
    expect(result).toContain('migrate');
  });

  it('dry_run for drizzle shows drizzle-kit command', async () => {
    const result = await exec({ connection_id: 'test-db', tool: 'drizzle', dry_run: true });
    expect(result).toContain('drizzle-kit');
  });

  it('custom tool with custom_command shows the command in dry_run', async () => {
    const result = await exec({
      connection_id: 'test-db',
      tool: 'custom',
      custom_command: 'node scripts/migrate.js up',
      dry_run: true,
    });
    expect(result).toContain('node');
    expect(result).toContain('scripts/migrate.js');
  });

  it('returns error when tool is "custom" and custom_command is missing', async () => {
    const result = await exec({ connection_id: 'test-db', tool: 'custom' });
    expect(result).toMatch(/custom_command is required/);
  });

  it('returns error for an unsupported tool name', async () => {
    const result = await exec({ connection_id: 'test-db', tool: 'liquibase' });
    expect(result).toMatch(/unsupported migration tool/);
  });
});
