import type {
  DatabaseProvider,
  ConnectionProfile,
  TableInfo,
  TableSchema,
  ColumnInfo,
  QueryResult,
} from './provider.js';
import { assertReadOnly, type QueryOptions } from './provider.js';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdentifier(name: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid ${label} name: "${name}". Only letters, digits, and underscores are allowed.`);
  }
}

// ---------------------------------------------------------------------------
// node:sqlite type shim -- only the subset we call. SQLite runs on Node's
// built-in module, not better-sqlite3: a native module would have to be built
// for VS Code's Electron on every platform, and the .vsix never shipped it, so
// every installed SideCar failed to open SQLite (#364). VS Code's extension
// host runs Node 24, which has node:sqlite.
// ---------------------------------------------------------------------------

interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  setReadBigInts(enabled: boolean): void;
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => NodeSqliteDatabase;
}

function loadNodeSqlite(): NodeSqliteModule {
  // getBuiltinModule, not import('node:sqlite'): it needs no type declarations
  // and returns undefined instead of throwing where the module doesn't exist.
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = getBuiltin?.('node:sqlite') as NodeSqliteModule | undefined;
  if (!mod) {
    throw new Error(
      `SQLite needs Node's built-in node:sqlite, which this VS Code's runtime (Node ${process.versions.node}) does not have. Update VS Code.`,
    );
  }
  return mod;
}

/** SQLite's message when a write meets a read-only connection or `query_only`. */
const SQLITE_READONLY_WRITE = /attempt to write a readonly database/i;

// ---------------------------------------------------------------------------
// PRAGMA shapes returned by SQLite
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

  private db: NodeSqliteDatabase | null = null;
  private connected = false;
  private readOnly = true;

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  async connect(profile: ConnectionProfile): Promise<void> {
    if (!profile.filePath) {
      throw new Error('SQLite connection requires a filePath');
    }
    const { DatabaseSync } = loadNodeSqlite();

    this.readOnly = profile.readOnly !== false; // default true
    this.db = new DatabaseSync(profile.filePath, { readOnly: this.readOnly });
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
      // Only introspect tables whose names are safe identifiers. SQLite allows
      // exotic names (spaces, quotes) that would break interpolation into
      // "double-quoted" identifier slots; skip those rows rather than risk
      // a malformed query.
      if (!SAFE_IDENTIFIER.test(row.name)) continue;
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

  async query(sql: string, params: unknown[] = [], opts: QueryOptions = {}): Promise<QueryResult> {
    const db = this.requireDb();

    const readOnly = this.readOnly || opts.readOnly === true;
    if (readOnly) {
      assertReadOnly(sql);
    }

    const limit = opts.limit ?? 1000;
    const statement = db.prepare(sql);
    // BigInt reads: without them node:sqlite throws on an integer beyond 2^53.
    statement.setReadBigInts(true);

    // node:sqlite runs synchronously -- it blocks the event loop for the
    // duration of the query. The practical mitigation for SQLite is the row
    // limit below.
    let rawRows: Array<Record<string, unknown>>;
    if (readOnly && !this.readOnly) {
      // A read on a read-write connection: SQLite's query_only makes the
      // engine refuse any write, which covers what a text check cannot
      // (PRAGMA forms, functions, triggers).
      db.exec('PRAGMA query_only = ON');
      try {
        rawRows = statement.all(...params) as Array<Record<string, unknown>>;
      } catch (err) {
        if (SQLITE_READONLY_WRITE.test(String(err))) {
          throw new Error('Read-only violation: SQLite refused this statement because it writes. Use db_execute.');
        }
        throw err;
      } finally {
        db.exec('PRAGMA query_only = OFF');
      }
    } else {
      try {
        rawRows = statement.all(...params) as Array<Record<string, unknown>>;
      } catch (err) {
        if (readOnly && SQLITE_READONLY_WRITE.test(String(err))) {
          throw new Error('Read-only violation: this connection is read-only. Use db_execute on a read-write profile.');
        }
        throw err;
      }
    }

    const truncated = rawRows.length > limit;
    const slicedRows = truncated ? rawRows.slice(0, limit) : rawRows;

    // Normalise each row: convert BigInt → number, keep nulls as null
    const rows: Record<string, unknown>[] = slicedRows.map((r) => normaliseRow(r));

    const columns = rows.length > 0 ? Object.keys(rows[0]) : inferColumns(sql);

    return {
      columns,
      rows,
      rowCount: rawRows.length,
      truncated,
    };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private requireDb(): NodeSqliteDatabase {
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
      // A number when it fits; past 2^53 a string, so the value stays exact.
      out[key] = Number.isSafeInteger(Number(val)) ? Number(val) : val.toString();
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
