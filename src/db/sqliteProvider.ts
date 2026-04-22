import type {
  DatabaseProvider,
  ConnectionProfile,
  TableInfo,
  TableSchema,
  ColumnInfo,
  QueryResult,
} from './provider.js';
import { assertReadOnly } from './provider.js';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdentifier(name: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid ${label} name: "${name}". Only letters, digits, and underscores are allowed.`);
  }
}

// ---------------------------------------------------------------------------
// better-sqlite3 type shim — we only reference the subset we actually use
// so the module can be dynamically imported without a hard dep at compile time.
// ---------------------------------------------------------------------------

interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[];
}

interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  close(): void;
}

interface BetterSqlite3Constructor {
  new (path: string, opts?: { readonly?: boolean }): BetterSqlite3Database;
}

// ---------------------------------------------------------------------------
// PRAGMA shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PragmaIndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface PragmaForeignKeyListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface SqliteMasterRow {
  name: string;
}

export class SqliteProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;

  private db: BetterSqlite3Database | null = null;
  private connected = false;
  private readOnly = true;

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  async connect(profile: ConnectionProfile): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Database } = (await import('better-sqlite3' as any)) as { default: BetterSqlite3Constructor };

    if (!profile.filePath) {
      throw new Error('SQLite connection requires a filePath');
    }

    this.readOnly = profile.readOnly !== false; // default true
    this.db = new Database(profile.filePath, { readonly: this.readOnly });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } finally {
        this.db = null;
        this.connected = false;
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // listTables
  // -------------------------------------------------------------------------

  async listTables(_schema?: string): Promise<TableInfo[]> {
    const db = this.requireDb();

    const masterRows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as SqliteMasterRow[];

    const tables: TableInfo[] = [];
    for (const row of masterRows) {
      let rowCount: number | undefined;
      try {
        const countRows = db.prepare(`SELECT COUNT(*) as cnt FROM "${row.name}"`).all() as Array<{ cnt: number }>;
        rowCount = countRows[0]?.cnt ?? undefined;
      } catch {
        rowCount = undefined;
      }
      tables.push({ name: row.name, schema: '', rowCount });
    }
    return tables;
  }

  // -------------------------------------------------------------------------
  // describeTable
  // -------------------------------------------------------------------------

  async describeTable(table: string, _schema?: string): Promise<TableSchema> {
    const db = this.requireDb();
    validateIdentifier(table, 'table');

    // Column info via PRAGMA table_info
    const pragmaRows = db.prepare(`PRAGMA table_info("${table}")`).all() as PragmaTableInfoRow[];

    // Foreign key list — build a lookup from column name → {table, column}
    const fkRows = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as PragmaForeignKeyListRow[];
    const fkMap = new Map<string, { table: string; column: string }>();
    for (const fk of fkRows) {
      fkMap.set(fk.from, { table: fk.table, column: fk.to });
    }

    const columns: ColumnInfo[] = pragmaRows.map((row) => {
      const fkRef = fkMap.get(row.name);
      return {
        name: row.name,
        type: row.type,
        nullable: row.notnull === 0,
        default: row.dflt_value,
        isPK: row.pk > 0,
        isFK: fkMap.has(row.name),
        references: fkRef,
      };
    });

    // Index list via PRAGMA index_list
    const indexListRows = db.prepare(`PRAGMA index_list("${table}")`).all() as PragmaIndexListRow[];
    const indexes: string[] = indexListRows.map((r) => {
      const uniqueLabel = r.unique ? 'UNIQUE ' : '';
      return `${uniqueLabel}INDEX ${r.name}`;
    });

    // Constraints — derive from column metadata (PKs + FKs)
    const constraints: string[] = [];
    const pkCols = columns.filter((c) => c.isPK).map((c) => c.name);
    if (pkCols.length > 0) {
      constraints.push(`PRIMARY KEY (${pkCols.join(', ')})`);
    }
    for (const fk of fkRows) {
      constraints.push(`FOREIGN KEY (${fk.from}) REFERENCES ${fk.table}(${fk.to})`);
    }

    // Approximate row count
    let approxRowCount: number | undefined;
    try {
      const countRows = db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).all() as Array<{ cnt: number }>;
      approxRowCount = countRows[0]?.cnt ?? undefined;
    } catch {
      approxRowCount = undefined;
    }

    return { columns, indexes, constraints, approxRowCount };
  }

  // -------------------------------------------------------------------------
  // query
  // -------------------------------------------------------------------------

  async query(
    sql: string,
    params: unknown[] = [],
    opts: { limit?: number; timeoutMs?: number } = {},
  ): Promise<QueryResult> {
    const db = this.requireDb();

    if (this.readOnly) {
      assertReadOnly(sql);
    }

    const limit = opts.limit ?? 1000;

    // better-sqlite3 is synchronous — wrap in async but note that it blocks
    // the event loop for the duration of the query. The practical timeout
    // mitigation for SQLite is the row limit below.
    const rawRows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    const truncated = rawRows.length > limit;
    const slicedRows = truncated ? rawRows.slice(0, limit) : rawRows;

    // Normalise each row: convert BigInt → number, keep nulls as null
    const rows: Record<string, unknown>[] = slicedRows.map((r) => normaliseRow(r));

    const columns = rows.length > 0 ? Object.keys(rows[0]) : inferColumns(sql);

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
    };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private requireDb(): BetterSqlite3Database {
    if (!this.db) {
      throw new Error('SQLite provider is not connected');
    }
    return this.db;
  }
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'bigint') {
      out[key] = Number(val);
    } else {
      out[key] = val ?? null;
    }
  }
  return out;
}

/**
 * Best-effort column extraction from a SELECT statement when there are no
 * result rows to infer from. Falls back to an empty array if the SQL is too
 * complex to parse simply.
 */
function inferColumns(sql: string): string[] {
  const match = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+/i);
  if (!match) return [];
  const selectPart = match[1].trim();
  if (selectPart === '*') return [];
  return selectPart.split(',').map((col) => {
    // Handle `expr AS alias` and `table.col`
    const parts = col.trim().split(/\s+as\s+/i);
    const last = parts[parts.length - 1].trim();
    // Strip table qualifier
    const dotParts = last.split('.');
    return dotParts[dotParts.length - 1].replace(/["'`]/g, '').trim();
  });
}
