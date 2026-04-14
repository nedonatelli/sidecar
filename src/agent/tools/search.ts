import { workspace } from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../../ollama/types.js';
import { getRoot, type ToolExecutorContext } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';

const execFileAsync = promisify(execFile);

// Search tools: search_files (glob), grep (content), find_references (symbol
// graph). `find_references` reads the symbol graph off the default
// ToolRuntime — populated by extension activation via `setSymbolGraph()`.
// Per-call runtimes (background agents) don't carry their own graph, so
// find_references falls back to the default's graph even when a per-call
// runtime is supplied. Symbol graphs are workspace-shared read-only data
// — only the shell session is per-agent state worth isolating.

export const searchFilesDef: ToolDefinition = {
  name: 'search_files',
  description:
    'Search for files matching a glob pattern in the workspace. Returns a list of matching file paths. ' +
    'Examples: "**/*.ts" for all TypeScript files, "src/**/test*.js" for test files under src/, "**/package.json" for all package manifests.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.js")' },
    },
    required: ['pattern'],
  },
};

export const grepDef: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents for a text pattern (string or regex). Returns matching lines with file paths and line numbers. ' +
    'Examples: grep "TODO" to find all TODOs, grep "function handleSubmit" to locate a function, grep "import.*express" path="src/" to find express imports under src/.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'Optional: limit search to this file or directory' },
    },
    required: ['pattern'],
  },
};

export const findReferencesDef: ToolDefinition = {
  name: 'find_references',
  description:
    'Find every reference to a symbol (function, class, type, variable) across the workspace using the tree-sitter symbol graph. ' +
    'Returns the definition location, files that import the defining module, and every usage site with file:line. ' +
    'Use before refactoring to understand blast radius, to find callers of a function, or to check whether a symbol is even used anywhere. ' +
    'Prefer this over `grep "functionName"` when you want semantic results — it won\'t match comments, strings, or unrelated identifiers with the same name, and it shows the export chain. ' +
    'Not for free-text search (use `grep`) or for finding files by name (use `search_files`). ' +
    'Example: `find_references(symbol="handleUserMessage")`, or `find_references(symbol="User", file="src/models/")` to scope to a subtree.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Name of the symbol to find references for (function, class, type, variable)',
      },
      file: {
        type: 'string',
        description: 'Optional: restrict search to references involving this file or directory (as definer or user).',
      },
    },
    required: ['symbol'],
  },
};

export async function searchFiles(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const uris = await workspace.findFiles(
    pattern,
    `**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next}/**`,
    200,
  );
  if (uris.length === 0) return 'No files found.';
  const root = getRoot();
  return uris.map((u) => path.relative(root, u.fsPath)).join('\n');
}

export async function grep(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) || '.';
  const cwd = getRoot();
  try {
    // Use execFile with args array to prevent shell injection
    const args = ['-rn', '--include=*', pattern, searchPath];
    const { stdout } = await execFileAsync('grep', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
    // Limit output
    const lines = stdout.split('\n').slice(0, 200);
    return lines.join('\n') || 'No matches found.';
  } catch (err) {
    const error = err as { stdout?: string; code?: number };
    if (error.code === 1) return 'No matches found.';
    return error.stdout || 'Grep failed.';
  }
}

export async function findReferences(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  // Prefer the per-call runtime's graph if it carries one, otherwise
  // fall back to the workspace-shared default. Background agents don't
  // populate their own graph, so in practice this almost always falls
  // through — the explicit check keeps the door open for future tests
  // or sub-agents that want to inject a mock graph.
  const graph = context?.toolRuntime?.symbolGraph ?? getDefaultToolRuntime().symbolGraph;
  if (!graph) {
    return 'Symbol graph is not available. The workspace may still be indexing.';
  }

  const symbolName = (input.symbol as string) || '';
  const filterFile = input.file as string | undefined;

  if (!symbolName) return 'Error: symbol name is required.';

  // Look up definitions
  let definitions = graph.lookupSymbol(symbolName);
  if (filterFile) {
    definitions = definitions.filter((d) => d.filePath === filterFile || d.filePath.includes(filterFile));
  }

  if (definitions.length === 0) {
    return `No symbol named "${symbolName}" found in the index.`;
  }

  const parts: string[] = [];

  // Show definitions
  parts.push(`## Definitions of "${symbolName}"\n`);
  for (const def of definitions.slice(0, 10)) {
    parts.push(
      `- ${def.exported ? 'export ' : ''}${def.type} **${def.qualifiedName}** — ${def.filePath}:${def.startLine + 1}`,
    );
  }

  // Show dependents (files that import the defining file)
  const allDependents = new Set<string>();
  for (const def of definitions) {
    for (const dep of graph.getDependents(def.filePath)) {
      allDependents.add(dep);
    }
  }
  if (allDependents.size > 0) {
    parts.push(`\n## Files importing the defining module(s)\n`);
    const depList = [...allDependents].slice(0, 20);
    for (const dep of depList) {
      parts.push(`- ${dep}`);
    }
    if (allDependents.size > 20) {
      parts.push(`- ... and ${allDependents.size - 20} more`);
    }
  }

  // Find actual usage sites
  const references = graph.findReferences(symbolName);
  const filtered = filterFile
    ? references.filter((r) => r.file === filterFile || r.file.includes(filterFile))
    : references;

  if (filtered.length > 0) {
    parts.push(`\n## Usage sites (${filtered.length} references)\n`);
    for (const ref of filtered.slice(0, 30)) {
      parts.push(`- ${ref.file}:${ref.line} — \`${ref.context}\``);
    }
    if (filtered.length > 30) {
      parts.push(`- ... and ${filtered.length - 30} more`);
    }
  }

  // Truncate to 5000 chars
  let result = parts.join('\n');
  if (result.length > 5000) {
    result = result.slice(0, 4950) + '\n... (truncated)';
  }

  return result;
}
