import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertReadOnly } from './provider.js';
import { SqliteProvider } from './sqliteProvider.js';
import { DuckDbProvider } from './duckdbProvider.js';

// db_query needs no approval and promises a read. Its only guard on a
// read-write connection was a text check with gaps; these run against the real
// engines, which now refuse the write themselves.

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbro-'));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP SECRET\n');
});
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* an engine may still hold its file on Windows */
  }
});

describe('assertReadOnly sees past comments and quoted names', () => {
  it.each([
    "SELECT set_config/**/('default_transaction_read_only', 'off', false)",
    "SELECT \"set_config\"('default_transaction_read_only', 'off', false)",
    "SELECT lo_from_bytea(0, 'x')",
    "SELECT pg_create_logical_replication_slot('s', 'test_decoding')",
    'PRAGMA journal_mode(DELETE)',
  ])('refuses %s', (sql) => {
    expect(() => assertReadOnly(sql)).toThrow(/Read-only violation/);
  });

  it.each(['SELECT 1', 'PRAGMA table_info(users)', "SELECT name FROM t WHERE note = 'x'"])('allows %s', (sql) => {
    expect(() => assertReadOnly(sql)).not.toThrow();
  });
});

describe('SQLite: a read on a read-write profile cannot write', () => {
  it('refuses a writing statement the text check would let through, and allows a read', async () => {
    const file = path.join(dir, 'rw.sqlite');
    const p = new SqliteProvider();
    await p.connect({ id: 'rw', type: 'sqlite', filePath: file, readOnly: false } as never);
    await expect(p.query('SELECT 1 AS one', [], { readOnly: true })).resolves.toMatchObject({ rowCount: 1 });
    // The function form of a setting pragma: a write by SQLite's own account.
    await expect(p.query('PRAGMA user_version(7)', [], { readOnly: true })).rejects.toThrow(/Read-only violation/);
    await p.disconnect();
  });
});

describe('DuckDB: no file or URL access through db_query', () => {
  it('refuses read_text on a local file', async () => {
    const p = new DuckDbProvider();
    await p.connect({ id: 'd', type: 'duckdb', filePath: path.join(dir, 'x.duckdb'), readOnly: false } as never);
    const target = path.join(dir, 'secret.txt').replace(/\\/g, '/');
    await expect(p.query(`SELECT * FROM read_text('${target}')`, [], { readOnly: true })).rejects.toThrow(
      /external access|disabled/i,
    );
    await p.disconnect().catch(() => undefined);
  });
});
