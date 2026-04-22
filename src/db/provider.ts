export type DbDialect = 'sqlite' | 'postgres' | 'mysql' | 'duckdb';

export interface ConnectionProfile {
  id: string;
  name: string;
  dialect: DbDialect;
  /** SQLite / DuckDB file path */
  filePath?: string;
  /** Network dialects (postgres, mysql) */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** VS Code SecretStorage key for password */
  secretKey?: string;
  /** default true */
  readOnly?: boolean;
}

export interface TableInfo {
  name: string;
  schema?: string;
  rowCount?: number;
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  isPK: boolean;
  isFK: boolean;
  references?: { table: string; column: string };
}

export interface TableSchema {
  columns: ColumnInfo[];
  indexes: string[];
  constraints: string[];
  approxRowCount?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface DatabaseProvider {
  readonly dialect: DbDialect;
  connect(profile: ConnectionProfile, password?: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<TableSchema>;
  query(sql: string, params?: unknown[], opts?: { limit?: number; timeoutMs?: number }): Promise<QueryResult>;
}

/**
 * Checks a SQL string and throws if it contains anything other than
 * read-only statements. Uses an allowlist rather than a blocklist so
 * comment-injection bypass tricks (e.g. DR + comment + OP = DROP) cannot
 * bypass the guard.
 */
export function assertReadOnly(sql: string): void {
  // Strip single-line comments
  let stripped = sql.replace(/--[^\n]*/g, ' ');
  // Strip block comments
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, ' ');

  const statements = stripped.split(';');
  // Allowlist: only these statement types are permitted on read-only connections.
  const readPattern = /^\s*(SELECT|EXPLAIN|DESCRIBE|SHOW|WITH|PRAGMA|VALUES)\b/i;

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed.length === 0) continue;
    if (!readPattern.test(trimmed)) {
      const verb = trimmed.split(/\s+/)[0]?.toUpperCase() ?? trimmed;
      throw new Error(`Read-only violation: ${verb} statement is not permitted on a read-only connection`);
    }
  }
}
