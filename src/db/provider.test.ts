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

  it('allows multiple read-only statements separated by semicolons', () => {
    expect(() => assertReadOnly('SELECT 1; SELECT 2; SELECT 3')).not.toThrow();
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

  it('strips single-line comments before checking', () => {
    // "-- INSERT" in a comment must not trigger a false positive
    expect(() => assertReadOnly('SELECT 1 -- INSERT INTO t VALUES (1)')).not.toThrow();
  });

  it('strips block comments before checking', () => {
    expect(() => assertReadOnly('SELECT /* DELETE FROM t */ 1')).not.toThrow();
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
