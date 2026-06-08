import * as fs from 'fs';
import * as path from 'path';

// Lazy-loaded on first HistoryDb construction to avoid slowing extension startup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Database: any = null;
function getDatabase() {
  if (!_Database) {
    _Database = require('better-sqlite3');
  }
  return _Database as typeof import('better-sqlite3');
}

export interface EvalRunRecord {
  timestamp: number;
  model: string;
  caseId: string;
  passed: boolean;
  durationMs: number;
  iterationsUsed: number;
  failures: string[];
  tags: string[];
}

export type QueryRow = Record<string, unknown>;

/**
 * Persistent SQLite store for eval results and session history.
 *
 * Lives at .sidecar/history.db — gitignored (generated per-user state).
 * The agent queries it via the query_history tool using read-only SELECT.
 *
 * Two tables for the first slice:
 *   eval_runs      — one row per eval case per run
 *   eval_baselines — materialized pass rates, updated after each run
 */
export class HistoryDb {
  private db: import('better-sqlite3').Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = getDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp    INTEGER NOT NULL,
        model        TEXT    NOT NULL,
        case_id      TEXT    NOT NULL,
        passed       INTEGER NOT NULL,
        duration_ms  INTEGER,
        iterations   INTEGER,
        failures     TEXT,
        tags         TEXT
      );

      CREATE TABLE IF NOT EXISTS eval_baselines (
        model        TEXT    NOT NULL,
        case_id      TEXT    NOT NULL,
        pass_rate    REAL    NOT NULL,
        last_passed  INTEGER NOT NULL,
        run_count    INTEGER NOT NULL,
        last_updated INTEGER NOT NULL,
        PRIMARY KEY (model, case_id)
      );

      CREATE INDEX IF NOT EXISTS idx_eval_runs_model_case
        ON eval_runs (model, case_id);
    `);
  }

  insertEvalRun(record: EvalRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO eval_runs
           (timestamp, model, case_id, passed, duration_ms, iterations, failures, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.timestamp,
        record.model,
        record.caseId,
        record.passed ? 1 : 0,
        record.durationMs,
        record.iterationsUsed,
        JSON.stringify(record.failures),
        JSON.stringify(record.tags),
      );

    this.upsertBaseline(record.model, record.caseId, record.passed);
  }

  private upsertBaseline(model: string, caseId: string, passed: boolean): void {
    const existing = this.db
      .prepare('SELECT pass_rate, run_count FROM eval_baselines WHERE model=? AND case_id=?')
      .get(model, caseId) as { pass_rate: number; run_count: number } | undefined;

    const now = Date.now();
    const passedInt = passed ? 1 : 0;

    if (existing) {
      const newCount = existing.run_count + 1;
      const newRate = (existing.pass_rate * existing.run_count + passedInt) / newCount;
      this.db
        .prepare(
          `UPDATE eval_baselines
           SET pass_rate=?, last_passed=?, run_count=?, last_updated=?
           WHERE model=? AND case_id=?`,
        )
        .run(newRate, passedInt, newCount, now, model, caseId);
    } else {
      this.db
        .prepare(
          `INSERT INTO eval_baselines (model, case_id, pass_rate, last_passed, run_count, last_updated)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(model, caseId, passedInt, passedInt, now);
    }
  }

  /**
   * Execute a read-only SELECT query. Throws on non-SELECT or invalid SQL.
   * Returns rows as plain objects.
   */
  query(sql: string): QueryRow[] {
    const trimmed = sql.trim();
    if (!/^SELECT\b/i.test(trimmed)) {
      throw new Error('Only SELECT queries are allowed.');
    }
    return this.db.prepare(trimmed).all() as QueryRow[];
  }

  /** Schema summary injected into the system prompt (~80 tokens). */
  static schemaBlock(): string {
    return `## Eval history database (SQLite, read-only)
Use query_history(sql) to query past eval results. Only SELECT is allowed.

eval_runs(id, timestamp, model, case_id, passed, duration_ms, iterations, failures, tags)
eval_baselines(model, case_id, pass_rate, last_passed, run_count, last_updated)

-- pass rates by model:
SELECT model, ROUND(AVG(passed)*100,1) as pct, COUNT(*) as runs FROM eval_runs GROUP BY model ORDER BY pct DESC
-- recent failures for a case:
SELECT model, failures, timestamp FROM eval_runs WHERE case_id=? AND passed=0 ORDER BY timestamp DESC LIMIT 5
-- regression check (last_passed=0 means most recent run failed):
SELECT model, case_id, pass_rate, last_passed FROM eval_baselines WHERE last_passed=0 ORDER BY pass_rate DESC`;
  }

  close(): void {
    this.db.close();
  }
}

/** Singleton DB instance, lazily initialized from the given path. */
let instance: HistoryDb | null = null;

export function getHistoryDb(dbPath: string): HistoryDb {
  if (!instance) {
    instance = new HistoryDb(dbPath);
  }
  return instance;
}

/** Reset singleton — used in tests. */
export function resetHistoryDb(): void {
  instance?.close();
  instance = null;
}
