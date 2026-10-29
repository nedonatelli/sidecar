import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertReadOnly } from './provider.js';

import { SqliteProvider } from './sqliteProvider.js';

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

  // Comment syntax differs by dialect, so the guard scans comments rather than
  // stripping them: a write word in a comment is refused (conservatively).
  it('refuses write keywords even inside comments', () => {
    expect(() => assertReadOnly('SELECT id -- INSERT ignored\nFROM users')).toThrow('Read-only violation');
    expect(() => assertReadOnly('SELECT id /* UPDATE ignored */ FROM users')).toThrow('Read-only violation');
  });

  it('allows a read whose comment contains no write word', () => {
    expect(() => assertReadOnly('SELECT id -- just the ids\nFROM users')).not.toThrow();
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

  it('blocks comment-injection bypass (DR/**/OP TABLE)', () => {
    // With a blocklist, DR/**/OP TABLE strips to DR  OP TABLE and bypasses \bDROP\b.
    // With an allowlist the stripped form DR  OP TABLE does not start with a
    // read-only keyword, so it is correctly rejected.
    expect(() => assertReadOnly('DR/**/OP TABLE users')).toThrow('Read-only violation');
    expect(() => assertReadOnly('INS/**/ERT INTO users VALUES (1)')).toThrow('Read-only violation');
  });

  it('allows EXPLAIN and PRAGMA', () => {
    expect(() => assertReadOnly('EXPLAIN SELECT * FROM users')).not.toThrow();
    expect(() => assertReadOnly('PRAGMA table_info("users")')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SqliteProvider unit tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SqliteProvider against a real database file, on Node's built-in node:sqlite
// (#364). Node 20, still in the CI matrix, has no node:sqlite; VS Code's
// extension host runs Node 24.
// ---------------------------------------------------------------------------

interface SeedDb {
  exec(sql: string): void;
  close(): void;
}

const nodeSqlite = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as
  | { DatabaseSync: new (p: string) => SeedDb }
  | undefined;

describe.skipIf(!nodeSqlite)('SqliteProvider', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-provider-'));
    file = path.join(dir, 'app.db');
    const { DatabaseSync } = nodeSqlite!;
    const seed = new DatabaseSync(file);
    seed.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT DEFAULT 'none');
      CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), big INTEGER);
      CREATE UNIQUE INDEX users_email ON users(email);
      INSERT INTO users (name, email) VALUES ('ada', 'a@x'), ('bob', 'b@x'), ('cy', 'c@x');
      INSERT INTO orders (user_id, big) VALUES (1, 42), (2, 9007199254740993);
    `);
    seed.close();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the file briefly */
    }
  });

  async function open(readOnly = true): Promise<SqliteProvider> {
    const p = new SqliteProvider();
    await p.connect({ id: 't', name: 'T', dialect: 'sqlite', filePath: file, readOnly });
    return p;
  }

  it('connects, and disconnect clears isConnected', async () => {
    const p = await open();
    expect(p.isConnected()).toBe(true);
    await p.disconnect();
    expect(p.isConnected()).toBe(false);
  });

  it('throws if filePath is missing', async () => {
    await expect(new SqliteProvider().connect({ id: 't', name: 'T', dialect: 'sqlite' })).rejects.toThrow(/filePath/);
  });

  it('disconnect is a no-op if never connected', async () => {
    await expect(new SqliteProvider().disconnect()).resolves.toBeUndefined();
  });

  it('listTables returns each table with its row count', async () => {
    const p = await open();
    expect(await p.listTables()).toEqual([
      { name: 'orders', schema: '', rowCount: 2 },
      { name: 'users', schema: '', rowCount: 3 },
    ]);
    await p.disconnect();
  });

  it('describeTable maps columns, keys, indexes and constraints', async () => {
    const p = await open();
    const users = await p.describeTable('users');
    expect(users.columns.map((c) => [c.name, c.type, c.nullable, c.isPK])).toEqual([
      ['id', 'INTEGER', true, true],
      ['name', 'TEXT', false, false],
      ['email', 'TEXT', true, false],
    ]);
    expect(users.columns[2].default).toBe("'none'");
    expect(users.indexes).toContain('UNIQUE INDEX users_email');
    expect(users.constraints).toContain('PRIMARY KEY (id)');
    expect(users.approxRowCount).toBe(3);

    const orders = await p.describeTable('orders');
    expect(orders.columns.find((c) => c.name === 'user_id')).toMatchObject({
      isFK: true,
      references: { table: 'users', column: 'id' },
    });
    await p.disconnect();
  });

  it('describeTable refuses an unsafe identifier', async () => {
    const p = await open();
    await expect(p.describeTable('users"; DROP TABLE users; --')).rejects.toThrow(/Invalid table name/);
    await p.disconnect();
  });

  it('query returns rows, binds parameters and truncates at the limit', async () => {
    const p = await open();
    const r = await p.query('SELECT name FROM users WHERE id > ? ORDER BY id', [1]);
    expect(r).toEqual({ columns: ['name'], rows: [{ name: 'bob' }, { name: 'cy' }], rowCount: 2, truncated: false });
    const capped = await p.query('SELECT id FROM users ORDER BY id', [], { limit: 2 });
    expect(capped).toMatchObject({ rowCount: 3, truncated: true });
    expect(capped.rows).toHaveLength(2);
    await p.disconnect();
  });

  it('returns a safe integer as a number and a larger one as an exact string', async () => {
    const p = await open();
    const r = await p.query('SELECT big FROM orders ORDER BY id');
    expect(r.rows).toEqual([{ big: 42 }, { big: '9007199254740993' }]);
    await p.disconnect();
  });

  it('refuses INSERT on a read-only connection', async () => {
    const p = await open(true);
    await expect(p.query("INSERT INTO users (name) VALUES ('x')")).rejects.toThrow(/Read-only violation/);
    await p.disconnect();
  });

  it('allows INSERT on a read-write connection', async () => {
    const p = await open(false);
    await p.query("INSERT INTO users (name, email) VALUES ('dee', 'd@x')");
    expect((await p.query('SELECT COUNT(*) AS n FROM users')).rows).toEqual([{ n: 4 }]);
    await p.disconnect();
  });

  it('a read on a read-write connection cannot write, and the connection still writes afterwards', async () => {
    const p = await open(false);
    await expect(p.query('PRAGMA user_version(7)', [], { readOnly: true })).rejects.toThrow(/Read-only violation/);
    expect((await p.query('PRAGMA user_version')).rows).toEqual([{ user_version: 0 }]);
    await p.query('PRAGMA user_version(3)');
    expect((await p.query('PRAGMA user_version')).rows).toEqual([{ user_version: 3 }]);
    await p.disconnect();
  });

  it('query throws when not connected', async () => {
    await expect(new SqliteProvider().query('SELECT 1')).rejects.toThrow(/not connected/);
  });
});
