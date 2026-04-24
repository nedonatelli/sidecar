/**
 * Database tools (v0.76 Tier 1 + v0.80 Tier 2).
 *
 * Tier 1 (read-only):
 *   db_list_connections  — list all configured DB profiles and their status.
 *   db_list_tables       — list tables in a connected database.
 *   db_describe_table    — describe columns, indexes, and constraints of a table.
 *   db_query             — run a read-only parameterized SQL query.
 *
 * Tier 2 (write, always requires approval):
 *   db_execute           — execute a write SQL statement (INSERT/UPDATE/DELETE/DDL).
 *   db_migrate_up        — run ORM migrations (Prisma / Alembic / Flyway / Drizzle).
 */

import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfig } from '../../config/settings.js';
import { connectionManager } from '../../db/connectionManager.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';
import type { RegisteredTool } from './shared.js';
import type { ConnectionProfile, QueryResult } from '../../db/provider.js';
import { getRoot } from './shared.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a QueryResult as a self-contained sortable HTML table.
 * The table emits data-col and data-sort attributes consumed by chat.js
 * event delegation for client-side column sorting.
 */
function renderQueryTable(result: QueryResult, title?: string): string {
  const { columns, rows, rowCount, truncated } = result;
  const headCells = columns
    .map(
      (col, i) =>
        `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #d1d5db;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;" data-col="${i}" data-sort="">${escHtml(col)} <span style="opacity:.5;font-size:.75em;">⇕</span></th>`,
    )
    .join('');
  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const val = row[col] ?? '';
          return `<td style="padding:5px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${escHtml(String(val))}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const caption = title
    ? `<caption style="caption-side:top;padding:6px 0;text-align:left;font-weight:600;font-size:.9em;">${escHtml(title)}</caption>`
    : '';
  const footer = truncated
    ? `<div style="padding:4px 10px;font-size:.8em;color:#6b7280;">Showing first ${rows.length} of ${rowCount} rows (truncated)</div>`
    : `<div style="padding:4px 10px;font-size:.8em;color:#6b7280;">${rowCount} row${rowCount === 1 ? '' : 's'}</div>`;

  return `<div class="sidecar-db-result" data-sortable="true" style="overflow-x:auto;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;">
<table style="border-collapse:collapse;width:100%;background:var(--vscode-editor-background,#fff);">${caption}
<thead><tr>${headCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>
${footer}
</div>`;
}

// ---------------------------------------------------------------------------
// db_list_connections
// ---------------------------------------------------------------------------

async function dbListConnections(
  _input: Record<string, unknown>,
  context?: import('./shared.js').ToolExecutorContext,
): Promise<string> {
  const profiles = (context?.config ?? getConfig()).databaseProfiles;
  if (profiles.length === 0) {
    return 'No database profiles configured. Add profiles under sidecar.databases.profiles in settings.';
  }
  const statuses = connectionManager.getStatus();
  const statusMap = new Map(statuses.map((s) => [s.id, s.connected]));

  const lines = profiles.map((p) => {
    const connected = statusMap.get(p.id) ? '✓ connected' : '○ not connected';
    const location =
      p.dialect === 'sqlite' || p.dialect === 'duckdb'
        ? (p.filePath ?? '(no file path)')
        : `${p.host ?? 'localhost'}:${p.port ?? defaultPort(p.dialect)}/${p.database ?? ''}`;
    return `${p.name} [${p.dialect}] — ${location} (${connected})${p.readOnly === false ? '' : ' [read-only]'}`;
  });
  return lines.join('\n');
}

function defaultPort(dialect: string): number {
  if (dialect === 'postgres') return 5432;
  if (dialect === 'mysql') return 3306;
  return 0;
}

// ---------------------------------------------------------------------------
// db_list_tables
// ---------------------------------------------------------------------------

async function dbListTables(input: Record<string, unknown>): Promise<string> {
  const connectionId = input.connection_id as string | undefined;
  const schema = input.schema as string | undefined;
  if (!connectionId) return 'Error: connection_id is required';

  const profile = findProfile(connectionId);
  if (!profile) return `Error: no database profile found with id "${connectionId}"`;

  let provider;
  try {
    provider = await connectionManager.getOrConnect(profile);
  } catch (err) {
    return `Error connecting to "${profile.name}": ${String(err)}`;
  }

  let tables;
  try {
    tables = await provider.listTables(schema);
  } catch (err) {
    return `Error listing tables: ${String(err)}`;
  }

  if (tables.length === 0) return `No tables found in ${profile.name}${schema ? ` (schema: ${schema})` : ''}`;

  const rows = tables.map((t) => {
    const parts = [t.schema ? `${t.schema}.${t.name}` : t.name];
    if (t.rowCount !== undefined) parts.push(`~${t.rowCount.toLocaleString()} rows`);
    if (t.comment) parts.push(`(${t.comment})`);
    return parts.join(' — ');
  });
  return `Tables in ${profile.name}:\n${rows.join('\n')}`;
}

// ---------------------------------------------------------------------------
// db_describe_table
// ---------------------------------------------------------------------------

async function dbDescribeTable(input: Record<string, unknown>): Promise<string> {
  const connectionId = input.connection_id as string | undefined;
  const table = input.table as string | undefined;
  const schema = input.schema as string | undefined;
  if (!connectionId) return 'Error: connection_id is required';
  if (!table) return 'Error: table is required';

  const profile = findProfile(connectionId);
  if (!profile) return `Error: no database profile found with id "${connectionId}"`;

  let provider;
  try {
    provider = await connectionManager.getOrConnect(profile);
  } catch (err) {
    return `Error connecting to "${profile.name}": ${String(err)}`;
  }

  let desc;
  try {
    desc = await provider.describeTable(table, schema);
  } catch (err) {
    return `Error describing table: ${String(err)}`;
  }

  const colLines = desc.columns.map((c) => {
    const flags = [
      c.isPK ? 'PK' : null,
      c.isFK ? `FK→${c.references ? `${c.references.table}.${c.references.column}` : '?'}` : null,
      c.nullable ? 'nullable' : 'not null',
      c.default !== null && c.default !== undefined ? `default: ${c.default}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return `  ${c.name} ${c.type}${flags ? ` [${flags}]` : ''}`;
  });

  const parts = [`Table: ${schema ? `${schema}.` : ''}${table}`, `Columns:\n${colLines.join('\n')}`];
  if (desc.indexes.length > 0) parts.push(`Indexes:\n${desc.indexes.map((ix) => `  ${ix}`).join('\n')}`);
  if (desc.constraints.length > 0) parts.push(`Constraints:\n${desc.constraints.map((c) => `  ${c}`).join('\n')}`);
  if (desc.approxRowCount !== undefined) parts.push(`Approximate row count: ${desc.approxRowCount.toLocaleString()}`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// db_query
// ---------------------------------------------------------------------------

async function dbQuery(
  input: Record<string, unknown>,
  context?: import('./shared.js').ToolExecutorContext,
): Promise<string> {
  const connectionId = input.connection_id as string | undefined;
  const sql = input.sql as string | undefined;
  const params = Array.isArray(input.params) ? (input.params as unknown[]) : [];
  const config = context?.config ?? getConfig();
  const limit =
    typeof input.limit === 'number'
      ? Math.min(input.limit, config.databaseQueryRowLimit)
      : config.databaseQueryRowLimit;
  const timeoutMs =
    typeof input.timeout_ms === 'number'
      ? Math.min(input.timeout_ms, config.databaseQueryTimeoutMs)
      : config.databaseQueryTimeoutMs;

  if (!connectionId) return 'Error: connection_id is required';
  if (!sql) return 'Error: sql is required';

  const profile = findProfile(connectionId);
  if (!profile) return `Error: no database profile found with id "${connectionId}"`;

  let provider;
  try {
    provider = await connectionManager.getOrConnect(profile);
  } catch (err) {
    return `Error connecting to "${profile.name}": ${String(err)}`;
  }

  let result: QueryResult;
  try {
    result = await provider.query(sql, params, { limit, timeoutMs });
  } catch (err) {
    return `Error: ${String(err)}`;
  }

  if (result.columns.length === 0 || result.rows.length === 0) {
    return `Query returned no rows. (${result.rowCount} total)`;
  }

  return renderQueryTable(result);
}

// ---------------------------------------------------------------------------
// db_execute
// ---------------------------------------------------------------------------

async function dbExecute(
  input: Record<string, unknown>,
  context?: import('./shared.js').ToolExecutorContext,
): Promise<string> {
  const connectionId = input.connection_id as string | undefined;
  const sql = input.sql as string | undefined;
  const params = Array.isArray(input.params) ? (input.params as unknown[]) : [];

  if (!connectionId) return 'Error: connection_id is required';
  if (!sql) return 'Error: sql is required';

  const profile = findProfile(connectionId);
  if (!profile) return `Error: no database profile found with id "${connectionId}"`;

  if (profile.readOnly !== false) {
    return `Error: connection "${profile.name}" is read-only. Set "readOnly: false" in the profile to allow writes.`;
  }

  // Audit Mode: buffer the SQL as a file so it appears in the audit review
  // treeview instead of executing immediately. The file is stored at
  // .sidecar/audit/db/{connectionId}/{timestamp}.sql for human inspection.
  const cfg = context?.config ?? getConfig();
  if (cfg.agentMode === 'audit') {
    const ts = Date.now();
    const auditPath = path.join('.sidecar', 'audit', 'db', connectionId, `${ts}.sql`);
    const paramsNote = params.length > 0 ? `\n-- params: ${JSON.stringify(params)}` : '';
    await getDefaultAuditBuffer().write(
      auditPath,
      `-- db_execute on "${profile.name}" (${profile.dialect})\n-- buffered ${new Date(ts).toISOString()}${paramsNote}\n${sql}\n`,
      async () => '',
    );
    return `db_execute buffered for audit review: ${auditPath}`;
  }

  let provider;
  try {
    provider = await connectionManager.getOrConnect(profile);
  } catch (err) {
    return `Error connecting to "${profile.name}": ${String(err)}`;
  }

  let result: QueryResult;
  try {
    result = await provider.query(sql, params, { limit: 0 });
  } catch (err) {
    return `Error: ${String(err)}`;
  }

  if (result.rows.length > 0) {
    return renderQueryTable(result, `Result from ${profile.name}`);
  }
  return `Statement executed on "${profile.name}". Rows affected: ${result.rowCount}`;
}

// ---------------------------------------------------------------------------
// db_migrate_up
// ---------------------------------------------------------------------------

type MigrationTool = 'prisma' | 'alembic' | 'flyway' | 'drizzle' | 'custom';

interface MigrationConfig {
  bin: string;
  args: string[];
}

function buildMigrationConfig(tool: MigrationTool, migrationDir: string, customCmd?: string): MigrationConfig | string {
  switch (tool) {
    case 'prisma':
      return {
        bin: 'npx',
        args: ['prisma', 'migrate', 'deploy', '--schema', path.join(migrationDir, 'schema.prisma')],
      };
    case 'alembic':
      return { bin: 'alembic', args: ['-c', path.join(migrationDir, 'alembic.ini'), 'upgrade', 'head'] };
    case 'flyway':
      return { bin: 'flyway', args: ['-locations=filesystem:' + migrationDir, 'migrate'] };
    case 'drizzle':
      return { bin: 'npx', args: ['drizzle-kit', 'migrate'] };
    case 'custom':
      if (!customCmd) return 'Error: custom_command is required when tool is "custom"';
      // Split safely — no shell invocation
      return { bin: customCmd.split(' ')[0] ?? '', args: customCmd.split(' ').slice(1) };
    default:
      return `Error: unsupported migration tool "${tool}"`;
  }
}

async function dbMigrateUp(input: Record<string, unknown>): Promise<string> {
  const connectionId = input.connection_id as string | undefined;
  const toolRaw = (input.tool as string | undefined) ?? 'prisma';
  const migrationDir = (input.migration_dir as string | undefined) ?? 'prisma';
  const customCmd = input.custom_command as string | undefined;
  const dryRun = input.dry_run === true;

  if (!connectionId) return 'Error: connection_id is required';

  const profile = findProfile(connectionId);
  if (!profile) return `Error: no database profile found with id "${connectionId}"`;

  const cwd = getRoot();
  const resolvedDir = path.isAbsolute(migrationDir) ? migrationDir : path.join(cwd, migrationDir);

  const cfg = buildMigrationConfig(toolRaw as MigrationTool, resolvedDir, customCmd);
  if (typeof cfg === 'string') return cfg;

  const { bin, args } = cfg;
  const displayCmd = [bin, ...args].join(' ');

  if (dryRun) {
    return `Migration dry-run (not executed):\n\nTool: ${toolRaw}\nCommand: ${displayCmd}\nDirectory: ${resolvedDir}\nConnection: ${profile.name} (${profile.dialect})\n\nCall again without dry_run=true to execute.`;
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return `Migration completed on "${profile.name}" via ${toolRaw}.\n\n${output || '(no output)'}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
    return `Migration failed: ${output}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProfile(id: string): ConnectionProfile | undefined {
  return getConfig().databaseProfiles.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const databaseTools: RegisteredTool[] = [
  {
    definition: {
      name: 'db_list_connections',
      description:
        'List all configured database connections and their current status (connected / not connected). ' +
        "Returns each connection's name, dialect (sqlite/postgres/mysql/duckdb), host/file location, and read-only flag. " +
        'Use this FIRST to discover valid connection_id values before calling db_list_tables, db_describe_table, or db_query. ' +
        'Example: `db_list_connections()` → "my-results [sqlite] — /data/results.db ○ not connected [read-only]".',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: dbListConnections,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'db_list_tables',
      description:
        'List all tables in a connected database. Returns table names with approximate row counts and schema. ' +
        'Use before db_query when you need to discover what tables exist. ' +
        'NOT for describing columns — use db_describe_table for that. ' +
        'Example: `db_list_tables(connection_id="my-db")` or `db_list_tables(connection_id="pg", schema="analytics")`.',
      input_schema: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: 'Connection ID from db_list_connections' },
          schema: {
            type: 'string',
            description: 'Schema/namespace to filter (optional; defaults to "public" for Postgres, "main" for DuckDB)',
          },
        },
        required: ['connection_id'],
      },
    },
    executor: dbListTables,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'db_describe_table',
      description:
        'Describe the schema of a specific table: columns (name, type, nullable, primary key, foreign keys), indexes, and constraints. ' +
        'Example: `db_describe_table(connection_id="my-db", table="users")`.',
      input_schema: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: 'Connection ID from db_list_connections' },
          table: { type: 'string', description: 'Table name to describe' },
          schema: { type: 'string', description: 'Schema/namespace (optional)' },
        },
        required: ['connection_id', 'table'],
      },
    },
    executor: dbDescribeTable,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'db_query',
      description:
        'Run a read-only parameterized SQL query against a database connection. ' +
        'Only SELECT and other read-only statements are permitted — INSERT/UPDATE/DELETE/DROP/ALTER/CREATE are blocked. ' +
        'Results are rendered as a sortable table in the chat panel. ' +
        'Use $1/$2 (Postgres/DuckDB), ? (MySQL/SQLite) as parameter placeholders. ' +
        'Example: `db_query(connection_id="my-db", sql="SELECT * FROM runs WHERE snr < $1 LIMIT 20", params=[-30])`.',
      input_schema: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: 'Connection ID from db_list_connections' },
          sql: { type: 'string', description: 'SQL query to execute (read-only)' },
          params: {
            type: 'array',
            items: {},
            description: 'Bind parameters for the query (positional)',
          },
          limit: {
            type: 'number',
            description: 'Maximum rows to return (default: sidecar.databases.queryRowLimit = 10000)',
          },
          timeout_ms: {
            type: 'number',
            description: 'Query timeout in milliseconds (default: sidecar.databases.queryTimeoutMs = 30000)',
          },
        },
        required: ['connection_id', 'sql'],
      },
    },
    executor: dbQuery,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'db_execute',
      description:
        'Execute a write SQL statement (INSERT, UPDATE, DELETE, DDL) on a database connection. ' +
        'Requires the connection profile to have readOnly set to false. ' +
        'Always requires user approval before execution. ' +
        'In Audit Mode the statement is buffered at .sidecar/audit/db/{connectionId}/{timestamp}.sql for review instead of executing immediately. ' +
        'Example: `db_execute(connection_id="my-db", sql="INSERT INTO logs (msg) VALUES (?)", params=["hello"])`.',
      input_schema: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: 'Connection ID from db_list_connections (must be read-write)' },
          sql: { type: 'string', description: 'SQL statement to execute (INSERT/UPDATE/DELETE/DDL)' },
          params: {
            type: 'array',
            items: {},
            description: 'Bind parameters for the statement (positional)',
          },
        },
        required: ['connection_id', 'sql'],
      },
    },
    executor: dbExecute,
    requiresApproval: true,
  },
  {
    definition: {
      name: 'db_migrate_up',
      description:
        'Run database migrations to the latest version using a supported ORM or migration tool. ' +
        'Supported tools: prisma, alembic, flyway, drizzle, custom. ' +
        'Always requires user approval. Use dry_run=true first to preview the command without executing it. ' +
        'Example: `db_migrate_up(connection_id="my-db", tool="prisma", migration_dir="prisma")` ' +
        'or `db_migrate_up(connection_id="my-db", tool="alembic", migration_dir="migrations", dry_run=true)`.',
      input_schema: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: 'Connection ID from db_list_connections' },
          tool: {
            type: 'string',
            enum: ['prisma', 'alembic', 'flyway', 'drizzle', 'custom'],
            description: 'Migration tool to use (default: prisma)',
          },
          migration_dir: {
            type: 'string',
            description: 'Path to migration directory relative to workspace root (default: "prisma")',
          },
          custom_command: {
            type: 'string',
            description: 'Full migration command when tool="custom" (e.g. "node scripts/migrate.js up")',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, show the command that would be run without executing it (default: false)',
          },
        },
        required: ['connection_id'],
      },
    },
    executor: dbMigrateUp,
    requiresApproval: true,
  },
];
