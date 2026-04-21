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
// pg type shim — only the surface we call at runtime.
// We avoid using the real `pg` types so this module compiles even without
// `pg` installed in devDependencies (it is dynamically imported at runtime).
// ---------------------------------------------------------------------------

interface PgPoolConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
}

interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
  fields: Array<{ name: string }>;
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPool;
}

// ---------------------------------------------------------------------------
// Row shapes from information_schema / pg_catalog
// ---------------------------------------------------------------------------

interface InfoSchemaTablesRow {
  table_name: string;
  table_schema: string;
}

interface PgClassRow {
  reltuples: string | number;
}

interface InfoSchemaColumnsRow {
  column_name: string;
  data_type: string;
  is_nullable: string; // 'YES' | 'NO'
  column_default: string | null;
}

interface PgIndexesRow {
  indexname: string;
  indexdef: string;
}

interface InfoSchemaKcuRow {
  column_name: string;
  constraint_name: string;
}

interface InfoSchemaTcRow {
  constraint_name: string;
  constraint_type: string; // 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK'
}

interface InfoSchemaRcuRow {
  column_name: string;
  table_name: string;
  constraint_name: string;
}

export class PostgresProvider implements DatabaseProvider {
  readonly dialect = 'postgres' as const;

  private pool: PgPool | null = null;
  private connected = false;
  private readOnly = true;
  private defaultDatabase = 'public';

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  async connect(profile: ConnectionProfile, password?: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgMod = (await import('pg' as any)) as unknown as { default?: PgModule } & PgModule;
    const { Pool } = pgMod.default ?? pgMod;

    this.readOnly = profile.readOnly !== false;
    this.defaultDatabase = profile.database ?? 'public';

    this.pool = new Pool({
      host: profile.host ?? 'localhost',
      port: profile.port ?? 5432,
      database: profile.database,
      user: profile.user,
      password,
      max: 3,
    });

    if (this.readOnly) {
      await this.pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.end();
      } finally {
        this.pool = null;
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
    const pool = this.requirePool();
    const targetSchema = schema ?? 'public';

    const result = await pool.query(
      `SELECT table_name, table_schema
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [targetSchema],
    );

    const tables: TableInfo[] = [];
    for (const rawRow of result.rows) {
      const row = rawRow as unknown as InfoSchemaTablesRow;
      let rowCount: number | undefined;
      try {
        const countResult = await pool.query(`SELECT reltuples::bigint AS reltuples FROM pg_class WHERE relname = $1`, [
          row.table_name,
        ]);
        const cntRow = countResult.rows[0] as unknown as PgClassRow | undefined;
        if (cntRow?.reltuples !== undefined && cntRow.reltuples !== null) {
          rowCount = Number(cntRow.reltuples);
        }
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
    const pool = this.requirePool();
    const targetSchema = schema ?? 'public';

    // Columns
    const colResult = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [targetSchema, table],
    );

    // Primary key columns
    const pkResult = await pool.query(
      `SELECT kcu.column_name
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc
         ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND kcu.table_schema = $1
         AND kcu.table_name = $2`,
      [targetSchema, table],
    );
    const pkCols = new Set((pkResult.rows as unknown as InfoSchemaKcuRow[]).map((r) => r.column_name));

    // Foreign key columns with their referenced table/column
    const fkResult = await pool.query(
      `SELECT kcu.column_name, ccu.table_name, kcu.constraint_name
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc
         ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND kcu.table_schema = $1
         AND kcu.table_name = $2`,
      [targetSchema, table],
    );
    const fkMap = new Map<string, { table: string; column: string }>();
    for (const rawRow of fkResult.rows) {
      const row = rawRow as unknown as InfoSchemaRcuRow;
      fkMap.set(row.column_name, { table: row.table_name, column: row.column_name });
    }

    const columns: ColumnInfo[] = (colResult.rows as unknown as InfoSchemaColumnsRow[]).map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      default: row.column_default ?? null,
      isPK: pkCols.has(row.column_name),
      isFK: fkMap.has(row.column_name),
      references: fkMap.get(row.column_name),
    }));

    // Indexes
    const idxResult = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
      [targetSchema, table],
    );
    const indexes: string[] = (idxResult.rows as unknown as PgIndexesRow[]).map((r) => r.indexdef ?? r.indexname);

    // Constraints — table-level
    const conResult = await pool.query(
      `SELECT constraint_name, constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema = $1 AND table_name = $2`,
      [targetSchema, table],
    );
    const constraints: string[] = (conResult.rows as unknown as InfoSchemaTcRow[]).map(
      (r) => `${r.constraint_type} ${r.constraint_name}`,
    );

    // Approx row count from pg_class
    let approxRowCount: number | undefined;
    try {
      const cntResult = await pool.query(`SELECT reltuples::bigint AS reltuples FROM pg_class WHERE relname = $1`, [
        table,
      ]);
      const cntRow = cntResult.rows[0] as unknown as PgClassRow | undefined;
      if (cntRow?.reltuples !== undefined && cntRow.reltuples !== null) {
        approxRowCount = Number(cntRow.reltuples);
      }
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
    const pool = this.requirePool();

    if (this.readOnly) {
      assertReadOnly(sql);
    }

    const limit = opts.limit ?? 1000;

    // Apply statement_timeout for this transaction via a wrapping DO block
    // is not possible in a pooled connection per-query, but we can set it
    // on the connection level using a separate query first.
    if (opts.timeoutMs !== undefined) {
      await pool.query(`SET statement_timeout = ${opts.timeoutMs}`);
    }

    const result = await pool.query(sql, params);

    const truncated = result.rows.length > limit;
    const slicedRows = truncated ? result.rows.slice(0, limit) : result.rows;
    const rows = slicedRows.map(normaliseRow);

    const columns = result.fields.map((f) => f.name);

    return { columns, rows, rowCount: rows.length, truncated };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private requirePool(): PgPool {
    if (!this.pool) {
      throw new Error('PostgreSQL provider is not connected');
    }
    return this.pool;
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
