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
// mysql2/promise type shim — only the surface we call at runtime
// ---------------------------------------------------------------------------

interface MySqlConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown[], Array<{ name: string }>]>;
  execute(sql: string, values?: unknown[]): Promise<[unknown[], Array<{ name: string }>]>;
  end(): Promise<void>;
}

interface MySqlModule {
  createConnection(config: MySqlConnectionConfig): Promise<MySqlConnection>;
}

interface MySqlConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

// ---------------------------------------------------------------------------
// Row shapes from information_schema / DESCRIBE / SHOW INDEXES
// ---------------------------------------------------------------------------

interface InfoSchemaTablesRow {
  TABLE_NAME: string;
  TABLE_ROWS: number | null;
}

interface DescribeRow {
  Field: string;
  Type: string;
  Null: string; // 'YES' | 'NO'
  Key: string; // 'PRI' | 'MUL' | 'UNI' | ''
  Default: string | null;
  Extra: string;
}

interface ShowIndexRow {
  Table: string;
  Non_unique: number;
  Key_name: string;
  Column_name: string;
  Index_type: string;
}

export class MysqlProvider implements DatabaseProvider {
  readonly dialect = 'mysql' as const;

  private conn: MySqlConnection | null = null;
  private connected = false;
  private readOnly = true;
  private defaultSchema: string | undefined;

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  async connect(profile: ConnectionProfile, password?: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mysqlMod = (await import('mysql2/promise' as any)) as unknown as { default?: MySqlModule } & MySqlModule;
    const mysql = mysqlMod.default ?? mysqlMod;

    this.readOnly = profile.readOnly !== false;
    this.defaultSchema = profile.database;

    this.conn = await mysql.createConnection({
      host: profile.host ?? 'localhost',
      port: profile.port ?? 3306,
      database: profile.database,
      user: profile.user,
      password,
    });

    if (this.readOnly) {
      await this.conn.query('SET SESSION TRANSACTION READ ONLY');
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      try {
        await this.conn.end();
      } finally {
        this.conn = null;
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
    const targetSchema = schema ?? this.defaultSchema;

    if (!targetSchema) {
      throw new Error('MySQL listTables requires a schema (database) name');
    }

    const [rows] = await conn.query(
      `SELECT TABLE_NAME, TABLE_ROWS
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [targetSchema],
    );

    return (rows as InfoSchemaTablesRow[]).map((row) => ({
      name: row.TABLE_NAME,
      schema: targetSchema,
      rowCount: row.TABLE_ROWS !== null && row.TABLE_ROWS !== undefined ? Number(row.TABLE_ROWS) : undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // describeTable
  // -------------------------------------------------------------------------

  async describeTable(table: string, schema?: string): Promise<TableSchema> {
    const conn = this.requireConn();
    const targetSchema = schema ?? this.defaultSchema;

    // DESCRIBE returns column info including PK markers
    const [descRows] = await conn.query(`DESCRIBE \`${table}\``);

    // SHOW INDEXES for index details
    const idxSql = targetSchema
      ? `SHOW INDEXES FROM \`${targetSchema}\`.\`${table}\``
      : `SHOW INDEXES FROM \`${table}\``;
    const [idxRows] = await conn.query(idxSql);

    // Build FK information from information_schema (DESCRIBE doesn't give FK targets)
    const fkMap = new Map<string, { table: string; column: string }>();
    if (targetSchema) {
      try {
        const [fkRows] = await conn.query(
          `SELECT kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE kcu
           JOIN information_schema.TABLE_CONSTRAINTS tc
             ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
             AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
             AND kcu.TABLE_NAME = tc.TABLE_NAME
           WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
             AND kcu.TABLE_SCHEMA = ?
             AND kcu.TABLE_NAME = ?`,
          [targetSchema, table],
        );
        for (const fk of fkRows as Array<{
          COLUMN_NAME: string;
          REFERENCED_TABLE_NAME: string;
          REFERENCED_COLUMN_NAME: string;
        }>) {
          fkMap.set(fk.COLUMN_NAME, {
            table: fk.REFERENCED_TABLE_NAME,
            column: fk.REFERENCED_COLUMN_NAME,
          });
        }
      } catch {
        // FK info is best-effort; continue without it
      }
    }

    const columns: ColumnInfo[] = (descRows as DescribeRow[]).map((row) => ({
      name: row.Field,
      type: row.Type,
      nullable: row.Null === 'YES',
      default: row.Default ?? null,
      isPK: row.Key === 'PRI',
      isFK: fkMap.has(row.Field),
      references: fkMap.get(row.Field),
    }));

    // Deduplicate index names (SHOW INDEXES has one row per column per index)
    const indexSet = new Set<string>();
    for (const idx of idxRows as ShowIndexRow[]) {
      const uniqueLabel = idx.Non_unique === 0 ? 'UNIQUE ' : '';
      indexSet.add(`${uniqueLabel}INDEX ${idx.Key_name}`);
    }
    const indexes = [...indexSet];

    // Derive constraints from PK + FK column info
    const constraints: string[] = [];
    const pkCols = (descRows as DescribeRow[]).filter((r) => r.Key === 'PRI').map((r) => r.Field);
    if (pkCols.length > 0) {
      constraints.push(`PRIMARY KEY (${pkCols.join(', ')})`);
    }
    for (const [col, ref] of fkMap.entries()) {
      constraints.push(`FOREIGN KEY (${col}) REFERENCES \`${ref.table}\`(\`${ref.column}\`)`);
    }

    return { columns, indexes, constraints };
  }

  // -------------------------------------------------------------------------
  // query
  // -------------------------------------------------------------------------

  async query(
    sql: string,
    params: unknown[] = [],
    opts: { limit?: number; timeoutMs?: number } = {},
  ): Promise<QueryResult> {
    const conn = this.requireConn();

    if (this.readOnly) {
      assertReadOnly(sql);
    }

    const limit = opts.limit ?? 1000;

    // mysql2 supports a timeout option on individual queries
    // We use the lower-level conn.query with the timeout option via the
    // options object. mysql2/promise wraps the callback API, so we pass
    // the timeout as part of the options object.
    // mysql2 accepts either (sql, values) or a single options object.
    // Passing an options object lets us include the timeout field.
    const [rows, fields] =
      opts.timeoutMs !== undefined
        ? await conn.query({ sql, values: params, timeout: opts.timeoutMs } as unknown as string, undefined)
        : await conn.query(sql, params);

    const rawRows = rows as Array<Record<string, unknown>>;
    const truncated = rawRows.length > limit;
    const slicedRows = truncated ? rawRows.slice(0, limit) : rawRows;
    const normRows = slicedRows.map(normaliseRow);

    const columns = (fields as Array<{ name: string }>).map((f) => f.name);

    return { columns, rows: normRows, rowCount: normRows.length, truncated };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private requireConn(): MySqlConnection {
    if (!this.conn) {
      throw new Error('MySQL provider is not connected');
    }
    return this.conn;
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
