import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseProvider, ConnectionProfile } from './provider.js';

// ---------------------------------------------------------------------------
// We need mutable references that the mock factories capture via closure.
// The vi.mock() factories are hoisted to the top of the module by Vitest's
// babel transform, so we declare the mocks first and let each test reassign
// them in beforeEach.
// ---------------------------------------------------------------------------

let sqliteMock: DatabaseProvider;
let postgresMock: DatabaseProvider;
let mysqlMock: DatabaseProvider;
let duckdbMock: DatabaseProvider;

vi.mock('./sqliteProvider.js', () => ({
  SqliteProvider: vi.fn(function (this: unknown) {
    return sqliteMock;
  }),
}));

vi.mock('./postgresProvider.js', () => ({
  PostgresProvider: vi.fn(function (this: unknown) {
    return postgresMock;
  }),
}));

vi.mock('./mysqlProvider.js', () => ({
  MysqlProvider: vi.fn(function (this: unknown) {
    return mysqlMock;
  }),
}));

vi.mock('./duckdbProvider.js', () => ({
  DuckDbProvider: vi.fn(function (this: unknown) {
    return duckdbMock;
  }),
}));

import { ConnectionManager } from './connectionManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMockProvider = (): DatabaseProvider => ({
  dialect: 'sqlite',
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  listTables: vi.fn().mockResolvedValue([]),
  describeTable: vi.fn().mockResolvedValue({ columns: [], indexes: [], constraints: [] }),
  query: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0, truncated: false }),
});

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'test-id',
    name: 'Test DB',
    dialect: 'sqlite',
    filePath: '/tmp/test.db',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectionManager', () => {
  beforeEach(() => {
    sqliteMock = makeMockProvider();
    postgresMock = { ...makeMockProvider(), dialect: 'postgres' };
    mysqlMock = { ...makeMockProvider(), dialect: 'mysql' };
    duckdbMock = { ...makeMockProvider(), dialect: 'duckdb' };
  });

  it('creates a SQLite provider and connects on first getOrConnect', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile({ dialect: 'sqlite' });

    const provider = await manager.getOrConnect(profile);

    expect(provider).toBe(sqliteMock);
    expect(sqliteMock.connect).toHaveBeenCalledWith(profile, undefined);
  });

  it('creates a Postgres provider for postgres dialect', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile({ dialect: 'postgres', host: 'localhost', database: 'mydb' });

    const provider = await manager.getOrConnect(profile);

    expect(provider).toBe(postgresMock);
    expect(postgresMock.connect).toHaveBeenCalledWith(profile, undefined);
  });

  it('creates a MySQL provider for mysql dialect', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile({ dialect: 'mysql', host: 'localhost', database: 'mydb' });

    const provider = await manager.getOrConnect(profile);

    expect(provider).toBe(mysqlMock);
  });

  it('creates a DuckDB provider for duckdb dialect', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile({ dialect: 'duckdb', filePath: '/tmp/data.duckdb' });

    const provider = await manager.getOrConnect(profile);

    expect(provider).toBe(duckdbMock);
  });

  it('returns the same provider instance on a second call if still connected', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile();

    const first = await manager.getOrConnect(profile);
    const second = await manager.getOrConnect(profile);

    expect(first).toBe(second);
    // connect should only have been called once
    expect(sqliteMock.connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects when the existing provider is no longer connected', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile();

    await manager.getOrConnect(profile);

    // Simulate disconnect
    (sqliteMock.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await manager.getOrConnect(profile);

    // A new provider instance was created and connected
    expect(sqliteMock.connect).toHaveBeenCalledTimes(2);
  });

  it('passes the password to connect', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile({ dialect: 'postgres' });

    await manager.getOrConnect(profile, 'secret');

    expect(postgresMock.connect).toHaveBeenCalledWith(profile, 'secret');
  });

  it('disconnect calls provider.disconnect and removes from registry', async () => {
    const manager = new ConnectionManager();
    const profile = makeProfile();

    await manager.getOrConnect(profile);
    await manager.disconnect(profile.id);

    expect(sqliteMock.disconnect).toHaveBeenCalledTimes(1);

    // getStatus should be empty
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('disconnect on unknown id is a no-op', async () => {
    const manager = new ConnectionManager();
    // Should not throw
    await expect(manager.disconnect('nonexistent')).resolves.toBeUndefined();
  });

  it('disconnectAll disconnects every tracked connection', async () => {
    const manager = new ConnectionManager();

    const profile1 = makeProfile({ id: 'a', dialect: 'sqlite' });
    const profile2 = makeProfile({ id: 'b', dialect: 'postgres' });

    await manager.getOrConnect(profile1);
    await manager.getOrConnect(profile2);

    await manager.disconnectAll();

    expect(sqliteMock.disconnect).toHaveBeenCalledTimes(1);
    expect(postgresMock.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('getStatus returns dialect and connected state for each connection', async () => {
    const manager = new ConnectionManager();

    const profile1 = makeProfile({ id: 'a', name: 'SQLite DB', dialect: 'sqlite' });
    const profile2 = makeProfile({ id: 'b', name: 'Postgres DB', dialect: 'postgres' });

    await manager.getOrConnect(profile1);
    await manager.getOrConnect(profile2);

    const status = manager.getStatus();

    expect(status).toHaveLength(2);

    const sqliteStatus = status.find((s) => s.id === 'a');
    expect(sqliteStatus).toEqual({ id: 'a', name: 'SQLite DB', dialect: 'sqlite', connected: true });

    const pgStatus = status.find((s) => s.id === 'b');
    expect(pgStatus).toEqual({ id: 'b', name: 'Postgres DB', dialect: 'postgres', connected: true });
  });
});
