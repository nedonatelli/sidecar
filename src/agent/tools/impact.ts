import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import type { ImpactedItem, ImpactSeed } from '../../config/symbolGraph.js';
import { requireSymbolGraph } from './graphToolSupport.js';

/**
 * `analyze_impact` — change-impact analysis over the symbol graph. Given the
 * symbols (or a file) a change touches, returns the downstream symbols/files
 * potentially affected: transitive callers, symbols that use a changed symbol
 * as a type, declared subtypes, and importers of the defining file.
 *
 * Edges are import-resolved to the changed symbol's defining file, so a
 * same-named symbol elsewhere doesn't contaminate the report. It stays advisory
 * — extraction is regex-based and dynamic dispatch isn't captured — so it's
 * "review these," not a proof of breakage. It's the consequence layer the
 * Project Knowledge Index can't provide: PKI answers "where is X?", this answers
 * "what depends on X?".
 */

const REASON_LABELS: Record<ImpactedItem['reason'], string> = {
  calls: 'Callers',
  'type-use': 'Type users',
  subtype: 'Subtypes',
  imports: 'Importers',
};
const REASON_ORDER: ImpactedItem['reason'][] = ['calls', 'type-use', 'subtype', 'imports'];
const PER_GROUP_LIMIT = 25;

export const analyzeImpactDef: ToolDefinition = {
  name: 'analyze_impact',
  description:
    'Change-impact analysis: given the symbols (or a file) you are about to change, returns what depends on them — ' +
    'transitive callers, symbols that use them as a type, subtypes, and files that import them. ' +
    'Use BEFORE or AFTER editing an exported function/type/class to find what might break downstream. ' +
    'Complements `project_knowledge_search` ("where is X?") by answering "what depends on X?". ' +
    'Pass `symbols` (names) or `file` (relative path — analyzes every symbol it defines). ' +
    'Import-resolved (same-named symbols elsewhere are excluded) but advisory: treat results as "review these", not a proof of breakage. ' +
    'Example: `analyze_impact(symbols=["requireAuth"])` or `analyze_impact(file="src/auth.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of the changed symbols (functions / classes / interfaces / types).',
      },
      file: {
        type: 'string',
        description: 'Relative path of a changed file — analyzes the impact of every symbol it defines.',
      },
      maxDepth: {
        type: 'number',
        description: 'How many caller hops to walk transitively (1–3). Default: 2.',
      },
    },
    required: [],
  },
};

export async function analyzeImpact(input: Record<string, unknown>): Promise<string> {
  const graph = requireSymbolGraph();
  if (!graph || graph.fileCount() === 0) {
    return (
      'Symbol graph not available yet (workspace still indexing, or no indexed code files). ' +
      'Retry shortly, or fall back to `grep` / `project_knowledge_search` to find dependents manually.'
    );
  }

  // Build {name, file} seeds so impactOf resolves edges against the import
  // graph (binding-accurate) instead of matching on name alone.
  const seeds: ImpactSeed[] = [];
  const file = typeof input.file === 'string' && input.file.trim() ? input.file.trim() : undefined;
  let scopeLabel: string;
  if (file) {
    const syms = graph.getSymbolsInFile(file);
    if (syms.length === 0) {
      return `No indexed symbols found in "${file}". Check the relative path, or pass \`symbols\` explicitly.`;
    }
    for (const s of syms) seeds.push({ name: s.name, file });
    scopeLabel = `${file} (${syms.length} symbol${syms.length === 1 ? '' : 's'})`;
  } else if (Array.isArray(input.symbols)) {
    const names = input.symbols
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
    if (names.length === 0) return 'Error: provide `symbols` (a list of names) or `file` (a relative path).';
    for (const name of names) {
      // Resolve each name to its defining file(s) so collisions don't inflate
      // the report; fall back to a name-only seed when the symbol is unknown.
      const defs = graph.lookupSymbol(name);
      if (defs.length === 0) seeds.push({ name });
      else for (const def of defs) seeds.push({ name, file: def.filePath });
    }
    scopeLabel = names.join(', ');
  } else {
    return 'Error: provide `symbols` (a list of names) or `file` (a relative path).';
  }

  const maxDepth = typeof input.maxDepth === 'number' ? Math.max(1, Math.min(3, Math.floor(input.maxDepth))) : 2;

  const report = graph.impactOf(seeds, { maxDepth });
  if (report.length === 0) {
    return (
      `No downstream impact found for ${scopeLabel} — no callers, type users, subtypes, or importers in the index. ` +
      'Note: only exported symbols surface importers, and dynamic dispatch is not captured.'
    );
  }

  const groups = new Map<ImpactedItem['reason'], ImpactedItem[]>();
  for (const item of report) {
    const list = groups.get(item.reason);
    if (list) list.push(item);
    else groups.set(item.reason, [item]);
  }

  const out: string[] = [`Impact of changing ${scopeLabel} — ${report.length} potentially affected (advisory):`, ''];
  for (const reason of REASON_ORDER) {
    const list = groups.get(reason);
    if (!list || list.length === 0) continue;
    out.push(`**${REASON_LABELS[reason]}** (${list.length}):`);
    for (const item of list.slice(0, PER_GROUP_LIMIT)) {
      const loc = item.line ? `${item.file}:${item.line}` : item.file;
      const where = item.name && item.name !== item.file ? `${item.name} — ${loc}` : loc;
      out.push(`- ${where} — ${item.detail}${reason === 'calls' && item.hops > 1 ? ` (${item.hops} hops)` : ''}`);
    }
    if (list.length > PER_GROUP_LIMIT) out.push(`- …and ${list.length - PER_GROUP_LIMIT} more`);
    out.push('');
  }

  return out.join('\n').trimEnd();
}

export const impactTools: RegisteredTool[] = [
  { definition: analyzeImpactDef, executor: analyzeImpact, requiresApproval: false },
];
