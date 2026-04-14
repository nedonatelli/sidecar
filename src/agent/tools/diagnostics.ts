import { languages, Uri } from 'vscode';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import { scanFile, formatIssues } from '../securityScanner.js';
import { getRoot, getRootUri } from './shared.js';

// Diagnostics tool: merges VS Code's language-server diagnostics with
// SideCar's security scanner. Exported as a function (not just via the
// registry) because the agent loop also calls it directly after edits.

export const getDiagnosticsDef: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    "Fetch compiler errors, warnings, and lint issues from VS Code's language services for a file or the whole workspace. " +
    'Use after every `write_file` / `edit_file` to verify your change type-checks — per the operating rules, this is mandatory for any code edit. ' +
    "Also use before starting a task to understand what is already broken in the file, or before a final hand-off to confirm you've left the workspace clean. " +
    'Not for running tests (use `run_tests`) or for custom lint commands (use `run_command "npm run lint"` if the editor integration isn\'t picking them up). ' +
    'Omit `path` to get a project-wide summary. ' +
    'Example after an edit: `get_diagnostics(path="src/utils.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional: relative file path to get diagnostics for. Omit for all files.' },
    },
    required: [],
  },
};

export async function getDiagnostics(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string | undefined;
  const root = getRoot();

  if (filePath) {
    const fileUri = Uri.joinPath(getRootUri(), filePath);
    const diags = languages.getDiagnostics(fileUri);
    const results = diags.map((d) => {
      const line = d.range.start.line + 1;
      const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
      return `${filePath}:${line} [${severity}] ${d.message}`;
    });

    // Append security scan results
    const securityIssues = await scanFile(filePath);
    const securityOutput = formatIssues(securityIssues);
    if (securityOutput) results.push(securityOutput);

    return results.length > 0 ? results.join('\n') : `No diagnostics for ${filePath}`;
  }

  // All diagnostics
  const allDiags = languages.getDiagnostics();
  const results: string[] = [];
  for (const [uri, diags] of allDiags) {
    if (diags.length === 0) continue;
    const relPath = root ? path.relative(root, uri.fsPath) : uri.fsPath;
    if (relPath.includes('node_modules')) continue;
    for (const d of diags) {
      const line = d.range.start.line + 1;
      const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
      results.push(`${relPath}:${line} [${severity}] ${d.message}`);
    }
  }
  return results.length > 0 ? results.slice(0, 100).join('\n') : 'No diagnostics found.';
}
