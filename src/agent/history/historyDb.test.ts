import { describe, it, expect, afterEach } from 'vitest';
import { HistoryDb, getHistoryDb, resetHistoryDb, type EvalRunRecord } from './historyDb.js';

// Tests run against a real in-memory better-sqlite3 (a bundled dependency), so
// the actual table DDL, the running pass-rate math, and the SELECT-only guard
// are exercised — not a mock of them.

function makeRun(over: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    timestamp: 1_700_000_000_000,
    model: 'qwen3',
    caseId: 'case-1',
    passed: true,
    durationMs: 1234,
    iterationsUsed: 3,
    failures: [],
    tags: ['smoke'],
    ...over,
  };
}

describe('HistoryDb', () => {
  const dbs: HistoryDb[] = [];
  function newDb(): HistoryDb {
    const db = new HistoryDb(':memory:');
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    resetHistoryDb();
  });

  it('inserts an eval run and reads it back with typed coercions', () => {
    const db = newDb();
    db.insertEvalRun(makeRun({ passed: false, failures: ['assert x==1'], tags: ['a', 'b'] }));

    const rows = db.query('SELECT model, case_id, passed, failures, tags FROM eval_runs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'qwen3', case_id: 'case-1', passed: 0 });
    // arrays are JSON-serialized into TEXT columns
    expect(JSON.parse(rows[0].failures as string)).toEqual(['assert x==1']);
    expect(JSON.parse(rows[0].tags as string)).toEqual(['a', 'b']);
  });

  it('creates a baseline row on the first run for a model/case', () => {
    const db = newDb();
    db.insertEvalRun(makeRun({ passed: true }));
    const [baseline] = db.query('SELECT pass_rate, run_count, last_passed FROM eval_baselines');
    expect(baseline).toMatchObject({ pass_rate: 1, run_count: 1, last_passed: 1 });
  });

  it('updates the baseline as a running average across runs', () => {
    const db = newDb();
    db.insertEvalRun(makeRun({ passed: true })); // rate 1/1
    db.insertEvalRun(makeRun({ passed: false })); // rate 1/2 = 0.5
    db.insertEvalRun(makeRun({ passed: true })); // (0.5*2 + 1)/3 = 0.666…

    const [b] = db.query('SELECT pass_rate, run_count, last_passed FROM eval_baselines');
    expect(b.run_count).toBe(3);
    expect(b.last_passed).toBe(1); // most recent run passed
    expect(b.pass_rate as number).toBeCloseTo(2 / 3, 5);
  });

  it('tracks baselines per (model, case) independently', () => {
    const db = newDb();
    db.insertEvalRun(makeRun({ model: 'qwen3', caseId: 'c1', passed: true }));
    db.insertEvalRun(makeRun({ model: 'llama3', caseId: 'c1', passed: false }));
    const rows = db.query('SELECT model, case_id, pass_rate FROM eval_baselines ORDER BY model');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: 'llama3', pass_rate: 0 });
    expect(rows[1]).toMatchObject({ model: 'qwen3', pass_rate: 1 });
  });

  it('allows SELECT queries (case-insensitive)', () => {
    const db = newDb();
    db.insertEvalRun(makeRun());
    expect(() => db.query('  select count(*) as n from eval_runs')).not.toThrow();
    expect(db.query('select count(*) as n from eval_runs')[0].n).toBe(1);
  });

  it('rejects non-SELECT statements', () => {
    const db = newDb();
    for (const sql of ['INSERT INTO eval_runs (model) VALUES (1)', 'DELETE FROM eval_runs', 'DROP TABLE eval_runs']) {
      expect(() => db.query(sql)).toThrow('Only SELECT');
    }
  });

  it('schemaBlock names both tables and query_history', () => {
    const block = HistoryDb.schemaBlock();
    expect(block).toContain('eval_runs');
    expect(block).toContain('eval_baselines');
    expect(block).toContain('query_history');
  });

  it('getHistoryDb returns a singleton; resetHistoryDb clears it', () => {
    const a = getHistoryDb(':memory:');
    const b = getHistoryDb(':memory:');
    expect(a).toBe(b);
    resetHistoryDb();
    const c = getHistoryDb(':memory:');
    expect(c).not.toBe(a);
    resetHistoryDb();
  });
});
