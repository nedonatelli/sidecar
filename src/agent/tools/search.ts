import { workspace } from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../../ollama/types.js';
import { getRoot, resolveRoot, type ToolExecutorContext, type RegisteredTool } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import { compressGrepOutput } from './compression.js';

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
  nondeterministicOutput: true,
};

export const grepDef: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents for a text pattern (string or regex). Returns matching lines with file paths and line numbers. ' +
    'Use `^` to anchor to line start, `.*` to match anything between terms. ' +
    'Examples: `grep "TODO"` finds all TODOs, `grep "^export function"` finds top-level exports, `grep "import.*express" path="src/"` finds express imports under src/, `grep "class.*implements"` finds all class declarations with interfaces.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'Optional: limit search to this file or directory' },
    },
    required: ['pattern'],
  },
  nondeterministicOutput: true,
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
  nondeterministicOutput: true,
};

const SEARCH_EXCLUDES = `**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next}/**`;

export async function searchFiles(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  let uris = await workspace.findFiles(pattern, SEARCH_EXCLUDES, 200);
  let note = '';
  // A bare word ("config", "legacy") is not a glob — it only matches an exact
  // top-level filename, so it silently finds nothing. Models read "No files
  // found." as "the thing does not exist" and give up: granite concluded a
  // whole task was a no-op after name-searching for CONTENT
  // (search-then-edit-multi-file), and never looked inside a directory it had
  // already listed (latch-stale-fact). Retry a bare term as a name substring,
  // in file names and in directory names, before reporting nothing.
  if (uris.length === 0 && !/[*?{}[\]]/.test(pattern)) {
    const byName = await workspace.findFiles(`**/*${pattern}*`, SEARCH_EXCLUDES, 200);
    const inDir = await workspace.findFiles(`**/*${pattern}*/**`, SEARCH_EXCLUDES, 200);
    const seen = new Set<string>();
    uris = [...byName, ...inDir].filter((u) => !seen.has(u.fsPath) && seen.add(u.fsPath));
    if (uris.length > 0) {
      note = `(matched "${pattern}" as a name substring)\n`;
    }
  }
  if (uris.length === 0) {
    return (
      'No files found. Note: search_files matches file NAMES with glob patterns — it does not search file ' +
      'contents. To search inside files, use grep(pattern="..."). To match a name substring anywhere, use a ' +
      'glob like pattern="**/*name*".'
    );
  }
  const root = getRoot();
  return note + uris.map((u) => path.relative(root, u.fsPath)).join('\n');
}

// ---------------------------------------------------------------------------
// A zero-hit content search is the most common outcome this tool has, and it
// currently says "No matches found." and nothing else.
//
// Measured over a 300-run SWE-bench matrix: 287 of 653 greps (44%) returned
// nothing, and among runs that NEVER found the file they were trying to fix,
// 92% of their searches returned nothing while they searched MORE than runs
// that succeeded (4.3 vs 2.0 per run). The failure is not too few searches, it
// is that a dead end reads exactly like a live one.
//
// Three things the tool already knows at that moment and does not say:
//
//   1. It has been asked this before. 44.6% of zero-hit greps repeated a
//      pattern the same run had already proven absent — `tzkt_import` six
//      times in one run, six identical replies.
//   2. The pattern is a code SNIPPET, not a term. 67.9% contained spaces,
//      parens or colons — `class ArticleForm(forms.ModelForm):` pasted from
//      the issue, which cannot match as one line. The distinctive identifier
//      inside it usually CAN: that same run later found `ArticleForm` with 12
//      hits, several turns later.
//   3. The pattern is a PATH or glob (9.1%) — `admin_utils/**`, `model_fields/`
//      — which is a search_files query. search_files already redirects to grep
//      for the opposite mistake; grep never redirected back.
// ---------------------------------------------------------------------------

/** Language keywords that are never the distinctive term in a pasted snippet. */
const SNIPPET_STOPWORDS = new Set([
  'class',
  'def',
  'function',
  'return',
  'import',
  'from',
  'self',
  'this',
  'const',
  'let',
  'var',
  'async',
  'await',
  'public',
  'private',
  'static',
  'void',
  'true',
  'false',
  'null',
  'None',
  'True',
  'False',
  'if',
  'else',
  'for',
  'while',
  'try',
  'except',
  'catch',
  'raise',
  'throw',
  'with',
  'yield',
  'lambda',
  'new',
  'super',
  'extends',
  'implements',
  'type',
  'not',
  'and',
  'pass',
  'elif',
  'assert',
  'break',
  'continue',
  'switch',
  'case',
  'global',
  'nonlocal',
  'del',
  'print',
]);

/**
 * The most distinctive identifier inside a pasted snippet: the longest token
 * that is not a language keyword. Returns null when the pattern is already a
 * single bare term (nothing to relax to) or has no usable token.
 */
export function relaxSnippetPattern(pattern: string): string | null {
  if (!/[\s(){}:=.,'"\[\]]/.test(pattern)) return null; // already a single term
  const tokens = pattern.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const usable = tokens.filter((t) => !SNIPPET_STOPWORDS.has(t));
  if (usable.length === 0) return null;
  const best = usable.reduce((a, b) => (b.length > a.length ? b : a));
  return best === pattern ? null : best;
}

/** A pattern that is really a path or glob rather than file content. */
export function looksLikePathQuery(pattern: string): boolean {
  if (/\s/.test(pattern)) return false;
  return pattern.includes('/') || pattern.includes('*') || /\.(py|ts|js|tsx|jsx|go|rs|java|rb)$/.test(pattern);
}

/**
 * The search_files glob for a path-shaped grep pattern: match on the file or
 * directory NAME (its last real segment, extension dropped), because that is
 * what survives a wrong guess about where it lives: `django/contrib/admin/checks.py`
 * searches for any name containing `checks`. A bare extension glob such as
 * `*.py` is kept as-is, anchored under any directory.
 */
export function pathQueryGlob(pattern: string): string {
  const segment =
    pattern
      .split('/')
      .filter((s) => s && !/^\*+$/.test(s))
      .pop() ?? '';
  const stem = segment.replace(/\*/g, '').replace(/\.[A-Za-z0-9]+$/, '');
  return stem ? `**/*${stem}*` : `**/${pattern.replace(/^\/+/, '').replace(/^\*\*\//, '')}`;
}

export async function grep(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) || '.';
  const cwd = resolveRoot(context);

  const runGrep = async (pat: string, where: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('grep', ['-rn', '-E', '--include=*', pat, where], {
        cwd,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
      });
      const capped = stdout.split('\n').slice(0, 200).join('\n');
      return capped.trim() ? capped : null;
    } catch {
      return null;
    }
  };

  /**
   * Everything the tool knows once a search comes back empty. Each branch is
   * something it could already have said and did not.
   */
  const explainZeroHit = async (): Promise<string> => {
    const seen = context?.zeroHitPatterns;
    // Keyed on WHERE as well as what: absent from one directory is not absent
    // from the repository, and widening the search is the right next move.
    const key = JSON.stringify([searchPath, pattern]);
    const before = seen?.get(key) ?? 0;
    seen?.set(key, before + 1);

    if (before > 0) {
      return (
        `No matches found. You have already searched for this exact pattern ${before === 1 ? 'once' : `${before} times`} ` +
        `in this session and it was not in the repository then either. Repeating it will not change the answer — ` +
        `search for a different term, or use list_directory to see what is actually here.`
      );
    }

    if (looksLikePathQuery(pattern)) {
      return (
        `No matches found. "${pattern}" looks like a file path or glob, and grep searches file CONTENTS, not names. ` +
        `To find a file by name use search_files(pattern="${pathQueryGlob(pattern)}").`
      );
    }

    const relaxed = relaxSnippetPattern(pattern);
    if (relaxed) {
      const out = await runGrep(relaxed, searchPath);
      if (out) {
        return (
          `No matches found for "${pattern}" — it looks like a block of code rather than a single term, and grep ` +
          `matches one line at a time. Searching for "${relaxed}" instead DOES match:\n\n${compressGrepOutput(out)}`
        );
      }
      return (
        `No matches found. "${pattern}" looks like a block of code rather than a single term; its most distinctive ` +
        `identifier "${relaxed}" is not in the repository either, so this text is probably from the issue report ` +
        `rather than from this codebase. Search for the library symbol you expect to be wrong instead.`
      );
    }

    return (
      `No matches found. "${pattern}" does not appear anywhere in ${searchPath === '.' ? 'the repository' : searchPath}. ` +
      `If it came from the issue report it may be the reporter's own code, not this project's.`
    );
  };

  try {
    // -E enables extended regex: +, ?, |, () without backslashes.
    // Use execFile with args array to prevent shell injection.
    const args = ['-rn', '-E', '--include=*', pattern, searchPath];
    const { stdout } = await execFileAsync('grep', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
    // Cap raw lines first, then fold into the grouped/deduped form so
    // the model sees one file header per path and long match lines get
    // clipped around the keyword.
    const lines = stdout.split('\n').slice(0, 200);
    const capped = lines.join('\n');
    if (!capped.trim()) return await explainZeroHit();
    return compressGrepOutput(capped);
  } catch (err) {
    const error = err as { stdout?: string; code?: number; stderr?: string };
    if (error.code === 1) return await explainZeroHit();
    // Non-zero/non-1 exit typically means a regex syntax error. The grep
    // tool supports POSIX ERE (-E) — \s, \d, \w are not ERE syntax.
    // For Perl-style escapes use: run_command("grep -En 'pattern' .") or rg.
    const detail = error.stderr || error.stdout || '';
    const hint =
      'For Perl-style escapes (\\s, \\d, \\w) use run_command("grep -Pn \'pattern\' .") or run_command("rg \'pattern\'") instead.';
    return detail ? `Grep error: ${detail.trim()}\n${hint}` : `Grep failed. ${hint}`;
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

export const searchTools: RegisteredTool[] = [
  { definition: searchFilesDef, executor: searchFiles, requiresApproval: false },
  { definition: grepDef, executor: grep, requiresApproval: false },
  { definition: findReferencesDef, executor: findReferences, requiresApproval: false },
];
