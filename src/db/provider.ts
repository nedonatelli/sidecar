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
 * Checks a SQL string for write/DDL statements and throws if any are found.
 * Used by read-only providers to enforce the read-only constraint before
 * executing any query.
 */
export function assertReadOnly(sql: string): void {
  // Strip single-line comments
  let stripped = sql.replace(/--[^\n]*/g, ' ');
  // Strip block comments
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, ' ');

  const statements = stripped.split(';');
  const writePattern = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i;

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed.length === 0) continue;
    if (writePattern.test(trimmed)) {
      const verb = trimmed.split(/\s+/)[0]?.toUpperCase() ?? trimmed;
      throw new Error(`Read-only violation: ${verb} statement is not permitted on a read-only connection`);
    }
  }
}
