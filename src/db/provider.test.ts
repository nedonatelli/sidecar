import { describe, it, expect } from 'vitest';
import { assertReadOnly } from './provider.js';

describe('assertReadOnly', () => {
  // ── allowed statements ─────────────────────────────────────────────────────

  it('allows SELECT', () => {
    expect(() => assertReadOnly('SELECT * FROM users')).not.toThrow();
  });

  it('allows EXPLAIN', () => {
    expect(() => assertReadOnly('EXPLAIN SELECT * FROM users')).not.toThrow();
  });

  it('allows DESCRIBE', () => {
    expect(() => assertReadOnly('DESCRIBE users')).not.toThrow();
  });

  it('allows SHOW', () => {
    expect(() => assertReadOnly('SHOW TABLES')).not.toThrow();
  });

  it('allows WITH ... SELECT (non-mutating CTE)', () => {
    expect(() => assertReadOnly('WITH cte AS (SELECT id FROM users) SELECT * FROM cte')).not.toThrow();
  });

  it('allows PRAGMA', () => {
    expect(() => assertReadOnly('PRAGMA table_info(users)')).not.toThrow();
  });

  it('allows VALUES', () => {
    expect(() => assertReadOnly('VALUES (1, 2, 3)')).not.toThrow();
  });

  it('is case-insensitive for allowed keywords', () => {
    expect(() => assertReadOnly('select id from t')).not.toThrow();
    expect(() => assertReadOnly('Select id from t')).not.toThrow();
  });

  // One statement only. Splitting on ";" needs to know what is quoted, and
  // getting that wrong ran `SELECT '--'; DROP TABLE users` as two statements.
  it('refuses multiple statements, however they are quoted', () => {
    expect(() => assertReadOnly('SELECT 1; SELECT 2; SELECT 3')).toThrow(/single statement/);
    expect(() => assertReadOnly("SELECT '--'; DROP TABLE users;")).toThrow(/single statement/);
    expect(() => assertReadOnly('SELECT 1 AS "--"; DELETE FROM users;')).toThrow(/single statement/);
    expect(() => assertReadOnly("SELECT '/*'; DROP TABLE users; SELECT '*/'")).toThrow(/single statement/);
  });

  it('refuses read statements that write from the inside', () => {
    for (const sql of [
      'SELECT * INTO stolen FROM users',
      "SELECT * FROM users INTO OUTFILE '/tmp/x'",
      "SELECT 'a\\'b' INTO OUTFILE '/tmp/x'",
      'EXPLAIN ANALYZE DELETE FROM users',
      "WITH x AS (SELECT '--') DELETE FROM t",
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      "SELECT setval('s', 1)",
      "SELECT lo_export(1, '/tmp/x')",
      'PRAGMA writable_schema = 1',
      'SELECT 1 --x INTO OUTFILE "/tmp/a"',
    ]) {
      expect(() => assertReadOnly(sql), sql).toThrow(/Read-only violation/);
    }
  });

  it('still allows ordinary reads, including the replace() function', () => {
    expect(() => assertReadOnly("SELECT replace(name, 'a', 'b') FROM t WHERE status = 'deleted'")).not.toThrow();
    expect(() => assertReadOnly('-- top 10\nSELECT id, updated_at FROM t LIMIT 10')).not.toThrow();
  });

  it('ignores empty statements from trailing semicolons', () => {
    expect(() => assertReadOnly('SELECT 1;')).not.toThrow();
  });

  // ── blocked statements ─────────────────────────────────────────────────────

  it('blocks INSERT', () => {
    expect(() => assertReadOnly('INSERT INTO t VALUES (1)')).toThrow(/Read-only violation/);
    expect(() => assertReadOnly('INSERT INTO t VALUES (1)')).toThrow(/INSERT/);
  });

  it('blocks UPDATE', () => {
    expect(() => assertReadOnly('UPDATE t SET x=1 WHERE id=1')).toThrow(/Read-only violation/);
  });

  it('blocks DELETE', () => {
    expect(() => assertReadOnly('DELETE FROM t WHERE id=1')).toThrow(/Read-only violation/);
  });

  it('blocks DROP', () => {
    expect(() => assertReadOnly('DROP TABLE users')).toThrow(/Read-only violation/);
  });

  it('blocks CREATE', () => {
    expect(() => assertReadOnly('CREATE TABLE x (id INT)')).toThrow(/Read-only violation/);
  });

  it('blocks ALTER', () => {
    expect(() => assertReadOnly('ALTER TABLE t ADD COLUMN x INT')).toThrow(/Read-only violation/);
  });

  it('blocks TRUNCATE', () => {
    expect(() => assertReadOnly('TRUNCATE TABLE logs')).toThrow(/Read-only violation/);
  });

  // ── comment stripping ─────────────────────────────────────────────────────

  // Comments are NOT stripped before the write-word scan: what counts as a
  // comment differs by dialect (MySQL needs "-- " with a space), so stripping
  // can hide live code. A write word in a comment is a conservative refusal.
  it('scans comments too rather than trusting a dialect-specific strip', () => {
    expect(() => assertReadOnly('SELECT 1 -- INSERT INTO t VALUES (1)')).toThrow(/Read-only violation/);
    expect(() => assertReadOnly('SELECT /* DELETE FROM t */ 1')).toThrow(/Read-only violation/);
  });

  it('still catches write statement after comment is stripped', () => {
    expect(() => assertReadOnly('/* read-only please */ DELETE FROM t')).toThrow(/Read-only violation/);
  });

  // ── WITH CTE write-verb guard ─────────────────────────────────────────────

  it('blocks DELETE inside a WITH CTE', () => {
    expect(() => assertReadOnly('WITH cte AS (DELETE FROM logs RETURNING id) SELECT * FROM cte')).toThrow(
      /Read-only violation/,
    );
  });

  it('blocks UPDATE inside a WITH CTE', () => {
    expect(() => assertReadOnly('WITH cte AS (UPDATE t SET x=1 RETURNING id) SELECT * FROM cte')).toThrow(
      /Read-only violation/,
    );
  });

  it('blocks INSERT inside a WITH CTE', () => {
    expect(() => assertReadOnly('WITH cte AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM cte')).toThrow(
      /Read-only violation/,
    );
  });
});
