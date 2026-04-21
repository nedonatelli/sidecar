import type {
  DatabaseProvider,
  ConnectionProfile,
  TableInfo,
  TableSchema,
  ColumnInfo,
  QueryResult,
} from './provider.js';
import { assertReadOnly } from './provider.js';

// ---------------------------------------------------------------------------
// @duckdb/node-api type shim — only the surface we call at runtime
// ---------------------------------------------------------------------------

interface DuckDBInstance {
  connect(): Promise<DuckDBConnection>;
}

interface DuckDBInstanceConstructor {
  create(path: string): Promise<DuckDBInstance>;
}

interface DuckDBConnection {
  run(sql: string): Promise<DuckDBResult>;
  close(): void;
}

interface DuckDBResult {
  // Returns column descriptors
  columnNames(): string[];
  // Returns rows as plain JS objects
  getRows(): Promise<Array<Record<string, unknown>>>;
}

interface DuckDbModule {
  DuckDBInstance: DuckDBInstanceConstructor;
}

// ---------------------------------------------------------------------------
// information_schema row shapes
// ---------------------------------------------------------------------------

interface InfoSchemaTablesRow {
  table_name: string;
  table_schema: string;
}

interface InfoSchemaColumnsRow {
  column_name: string;
  data_type: string;
  is_nullable: string; // 'YES' | 'NO'
  column_default: string | null;
}

export class DuckDbProvider implements DatabaseProvider {
  readonly dialect = 'duckdb' as const;

  private instance: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  private connected = false;
  private readOnly = true;

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  async connect(profile: ConnectionProfile): Promise<void> {
    let mod: DuckDbModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = (await import('@duckdb/node-api' as any)) as unknown as DuckDbModule;
    } catch {
      throw new Error(
        'DuckDB not available — install @duckdb/node-api in your project to use the DuckDB database provider',
      );
    }

    this.readOnly = profile.readOnly !== false;

    const filePath = profile.filePath ?? ':memory:';
    this.instance = await mod.DuckDBInstance.create(filePath);
    this.conn = await this.instance.connect();
    this.connected = true;

    if (this.readOnly) {
      // DuckDB supports SET statement for read-only access on file databases.
      // For in-memory databases this is a no-op but harmless.
      try {
        await this.conn.run('SET access_mode = READ_ONLY');
      } catch {
        // Ignore if not supported on this DuckDB version / connection type
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      try {
        this.conn.close();
      } finally {
        this.conn = null;
        this.instance = null;
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

  async listTables(schema?: string): Promise<TableInfo[]> {
    const conn = this.requireConn();
    const targetSchema = schema ?? 'main';

    const result = await conn.run(
      `SELECT table_name, table_schema
       FROM information_schema.tables
       WHERE table_schema = '${escapeString(targetSchema)}'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );

    const rows = (await result.getRows()) as unknown as InfoSchemaTablesRow[];

    const tables: TableInfo[] = [];
    for (const row of rows) {
      let rowCount: number | undefined;
      try {
        const cntResult = await conn.run(`SELECT COUNT(*) AS cnt FROM "${escapeIdent(row.table_name)}"`);
        const cntRows = await cntResult.getRows();
        const val = cntRows[0]?.['cnt'];
        if (val !== undefined && val !== null) rowCount = Number(val);
      } catch {
        rowCount = undefined;
      }
      tables.push({ name: row.table_name, schema: row.table_schema, rowCount });
    }

    return tables;
  }

  // -------------------------------------------------------------------------
  // describeTable
  // -------------------------------------------------------------------------

  async describeTable(table: string, schema?: string): Promise<TableSchema> {
    const conn = this.requireConn();
    const targetSchema = schema ?? 'main';

    const colResult = await conn.run(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = '${escapeString(targetSchema)}'
         AND table_name = '${escapeString(table)}'
       ORDER BY ordinal_position`,
    );
    const colRows = (await colResult.getRows()) as unknown as InfoSchemaColumnsRow[];

    const columns: ColumnInfo[] = colRows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      default: row.column_default ?? null,
      isPK: false, // DuckDB information_schema doesn't expose PK easily without PRAGMA
      isFK: false,
    }));

    // DuckDB exposes indexes via pragma_database_list + duckdb_indexes
    let indexes: string[] = [];
    try {
      const idxResult = await conn.run(
        `SELECT index_name FROM duckdb_indexes()
         WHERE schema_name = '${escapeString(targetSchema)}'
           AND table_name = '${escapeString(table)}'`,
      );
      const idxRows = await idxResult.getRows();
      indexes = idxRows.map((r) => String(r['index_name'] ?? ''));
    } catch {
      indexes = [];
    }

    // Constraints: derive PKs from duckdb_constraints if available
    const constraints: string[] = [];
    try {
      const pkResult = await conn.run(
        `SELECT constraint_column_names
         FROM duckdb_constraints()
         WHERE schema_name = '${escapeString(targetSchema)}'
           AND table_name = '${escapeString(table)}'
           AND constraint_type = 'PRIMARY KEY'`,
      );
      const pkRows = await pkResult.getRows();
      for (const row of pkRows) {
        const cols = row['constraint_column_names'];
        if (Array.isArray(cols)) {
          constraints.push(`PRIMARY KEY (${cols.join(', ')})`);
          // Mark columns as PK
          for (const col of cols as string[]) {
            const found = columns.find((c) => c.name === col);
            if (found) found.isPK = true;
          }
        }
      }
    } catch {
      // best-effort
    }

    // Approx row count
    let approxRowCount: number | undefined;
    try {
      const cntResult = await conn.run(`SELECT COUNT(*) AS cnt FROM "${escapeIdent(table)}"`);
      const cntRows = await cntResult.getRows();
      const val = cntRows[0]?.['cnt'];
      if (val !== undefined && val !== null) approxRowCount = Number(val);
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
    _params: unknown[] = [],
    opts: { limit?: number; timeoutMs?: number } = {},
  ): Promise<QueryResult> {
    const conn = this.requireConn();

    if (this.readOnly) {
      assertReadOnly(sql);
    }

    const limit = opts.limit ?? 1000;

    // DuckDB node-api does not support parameterized queries in the same way
    // as pg or mysql2. Params are ignored here — callers should interpolate
    // safely or use DuckDB's string escaping. This matches the Tier 1 read-only
    // scope where injection risk is bounded by assertReadOnly above.
    const result = await conn.run(sql);
    const rawRows = await result.getRows();

    const truncated = rawRows.length > limit;
    const slicedRows = truncated ? rawRows.slice(0, limit) : rawRows;
    const rows = slicedRows.map(normaliseRow);

    const columns = result.columnNames();

    return { columns, rows, rowCount: rows.length, truncated };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private requireConn(): DuckDBConnection {
    if (!this.conn) {
      throw new Error('DuckDB provider is not connected');
    }
    return this.conn;
  }
}

/** Escape a SQL identifier by doubling internal double-quotes. */
function escapeIdent(name: string): string {
  return name.replace(/"/g, '""');
}

/** Escape a SQL string literal by doubling internal single-quotes. */
function escapeString(val: string): string {
  return val.replace(/'/g, "''");
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
