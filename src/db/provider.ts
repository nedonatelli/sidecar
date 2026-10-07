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
  query(sql: string, params?: unknown[], opts?: QueryOptions): Promise<QueryResult>;
}

export interface QueryOptions {
  limit?: number;
  timeoutMs?: number;
  /**
   * Enforce read-only for this statement even on a read-write connection.
   * db_query sets it: the tool promises a read, and needs no approval. The
   * provider then runs the statement where the database itself refuses
   * writes (a READ ONLY transaction, SQLite's statement check), not only
   * behind assertReadOnly's text check.
   */
  readOnly?: boolean;
}

/** Statement types a read-only query may start with. */
const READ_VERBS = /^(SELECT|EXPLAIN|DESCRIBE|SHOW|WITH|PRAGMA|VALUES)\b/i;
/**
 * What writes from INSIDE a statement that starts with a read verb:
 * data-modifying CTEs and `EXPLAIN ANALYZE <write>` (Postgres), `SELECT INTO`
 * and MySQL `INTO OUTFILE`, and functions that change state. `replace(` is the
 * string function, not MySQL's REPLACE statement (which cannot start here).
 */
const INNER_WRITES =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|INTO|CREATE|DROP|ALTER|TRUNCATE|ATTACH|DETACH|COPY|VACUUM)\b|\bREPLACE\b(?!\s*\()|\b(set_config|setval|nextval|pg_write_\w+|lo_\w+|lowrite|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_read_\w*file|pg_ls_\w+|pg_file_\w+|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_logical_\w+|pg_promote|pg_switch_wal|pg_rotate_logfile|pg_stat_reset\w*|pg_advisory\w*|query_to_xml\w*|load_extension|writefile|readfile|edit|fts3_tokenizer)\s*\(/i;

/** Pragmas that only read, even in their `name(arg)` form. */
const READ_ONLY_PRAGMAS =
  /^PRAGMA\s+(?:\w+\.)?(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|foreign_key_check|integrity_check|quick_check|database_list|compile_options|function_list|pragma_list|collation_list|module_list)\b/i;

/**
 * The statement with comments removed and identifier quotes dropped, so a
 * comment or a quoted name between a function and its parenthesis
 * (`set_config/**\/(`, `"set_config"(`) is still seen.
 */
function normalizeForScan(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/["`\[\]]/g, '')
    .replace(/\s+\(/g, '(');
}

/**
 * Throws unless `sql` is ONE read-only statement.
 *
 * Deliberately does not parse SQL. Quoting and comment rules differ by dialect
 * -- backslash escapes, `--` needing a trailing space in MySQL, `#`, `$$` --
 * and every place a parser disagrees with the database is a bypass: stripping
 * comments without knowing about strings let `SELECT '--'; DROP TABLE users`
 * through as one SELECT. So:
 *   - a `;` anywhere but at the very end is refused (no second statement,
 *     however it is quoted);
 *   - after leading comments, the statement must start with a read verb;
 *   - the RAW text, strings and comments included, must not contain anything
 *     that writes from inside a read statement.
 * The cost is a conservative false positive (`WHERE action = 'DELETE'`);
 * such a query belongs in db_execute, which asks for approval.
 */
export function assertReadOnly(sql: string): void {
  const body = sql.trim().replace(/;\s*$/, '');
  if (body.includes(';')) {
    throw new Error(
      'Read-only violation: only a single statement is permitted (found ";" before the end). ' +
        'Run statements one at a time.',
    );
  }

  let lead = body;
  for (;;) {
    const next = lead
      .replace(/^\s+/, '')
      .replace(/^--[^\n]*(\n|$)/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '');
    if (next === lead) break;
    lead = next;
  }
  if (!READ_VERBS.test(lead)) {
    const verb = lead.split(/\s+/)[0]?.toUpperCase() || 'EMPTY';
    throw new Error(`Read-only violation: ${verb} statement is not permitted on a read-only connection`);
  }

  const inner = INNER_WRITES.exec(body) ?? INNER_WRITES.exec(normalizeForScan(body));
  if (inner) {
    const word = (inner[1] ?? inner[2] ?? 'REPLACE').toUpperCase();
    throw new Error(
      `Read-only violation: "${word}" can write and is not permitted in a read-only query ` +
        `(this check also matches it inside strings and comments). Use db_execute, which asks for approval.`,
    );
  }
  // `PRAGMA name = value` and its documented function form `PRAGMA name(value)`
  // both set; only the known read-only pragmas may take an argument.
  if (/^PRAGMA\b/i.test(lead) && (lead.includes('=') || (lead.includes('(') && !READ_ONLY_PRAGMAS.test(lead)))) {
    throw new Error('Read-only violation: PRAGMA assignments change the database and are not permitted');
  }
}
