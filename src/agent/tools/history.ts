import * as path from 'path';
import type { RegisteredTool } from './shared.js';
import { getRoot } from './shared.js';
import { getHistoryDb } from '../history/historyDb.js';

function dbPath(): string {
  return path.join(getRoot(), '.sidecar', 'history.db');
}

export const queryHistoryTool: RegisteredTool = {
  requiresApproval: false,
  definition: {
    name: 'query_history',
    description:
      'Run a read-only SELECT query against the local eval history database. ' +
      'Tables: eval_runs(id, timestamp, model, case_id, passed, duration_ms, iterations, failures, tags), ' +
      'eval_baselines(model, case_id, pass_rate, last_passed, run_count, last_updated). ' +
      'Only SELECT statements are accepted. Returns rows as JSON. ' +
      'Example: `query_history(sql="SELECT model, ROUND(AVG(passed)*100,1) as pct FROM eval_runs GROUP BY model")`.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string',
          description: 'A SELECT query against eval_runs or eval_baselines.',
        },
      },
      required: ['sql'],
    },
  },
  executor: async (input) => {
    const sql = String(input.sql ?? '').trim();
    if (!sql) return 'Error: sql is required.';
    try {
      const db = getHistoryDb(dbPath());
      const rows = db.query(sql);
      if (rows.length === 0) return 'No results.';
      return JSON.stringify(rows, null, 2);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
