import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { requireSymbolGraph, SYMBOL_GRAPH_UNAVAILABLE } from './graphToolSupport.js';

// ---------------------------------------------------------------------------
// `query_code_graph` — the code-graph query interface (strategy §4).
//
// `analyze_impact` answers ONE question: "what breaks downstream if I change
// this?" (the blast radius). But understanding a change also needs the other
// directions — what does this call, who references it, what flows through its
// type. This exposes the graph SideCar already builds (tree-sitter call/type
// edges) as a general relationship query, so the agent can understand the
// consequences of an edit before making it — the invisible-20% between "edited
// the file" and "understood the edit".
//
// Read-only, advisory. Complements (does not replace) analyze_impact.
// ---------------------------------------------------------------------------

type Relation = 'callers' | 'callees' | 'references' | 'type-users' | 'neighborhood';
const RELATIONS: readonly Relation[] = ['callers', 'callees', 'references', 'type-users', 'neighborhood'];
const PER_GROUP_LIMIT = 25;

export const queryCodeGraphDef: ToolDefinition = {
  name: 'query_code_graph',
  description:
    'Query the code graph for how a symbol relates to the rest of the codebase — the consequences of an edit. ' +
    'Relations: `callers` (functions that CALL this symbol), `callees` (what this function calls), `references` ' +
    '(every mention of the symbol), `type-users` (symbols using this TYPE, and whether as a param/return/variable), ' +
    'or `neighborhood` (a combined summary — callers + callees + reference count). Complements `analyze_impact` ' +
    '(which reports downstream blast radius). Use before editing to understand what a change touches. ' +
    "Example: `query_code_graph(symbol='requireAuth', relation='callers')`.",
  input_schema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'The function / method / type name to query.' },
      relation: {
        type: 'string',
        enum: [...RELATIONS],
        description: 'Which relationship to return. Defaults to "neighborhood".',
      },
    },
    required: ['symbol'],
  },
};

function fmtList(header: string, items: string[]): string[] {
  if (items.length === 0) return [`${header}: none`];
  const out = [`${header} (${items.length}):`, ...items.slice(0, PER_GROUP_LIMIT).map((i) => `- ${i}`)];
  if (items.length > PER_GROUP_LIMIT) out.push(`- …and ${items.length - PER_GROUP_LIMIT} more`);
  return out;
}

export async function queryCodeGraph(input: Record<string, unknown>): Promise<string> {
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim() : '';
  if (!symbol) return 'Error: `symbol` is required.';
  const relation: Relation = RELATIONS.includes(input.relation as Relation)
    ? (input.relation as Relation)
    : 'neighborhood';

  const graph = requireSymbolGraph();
  if (!graph || graph.fileCount() === 0) {
    return SYMBOL_GRAPH_UNAVAILABLE;
  }

  const callers = (): string[] => graph.getCallers(symbol).map((e) => `${e.callerName} — ${e.callerFile}:${e.line}`);
  const callees = (): string[] => graph.getCallees(symbol).map((e) => `${e.calleeName} — ${e.callerFile}:${e.line}`);
  const references = (): string[] =>
    graph.findReferences(symbol, (p) => graph.getFileContent(p)).map((r) => `${r.file}:${r.line} — ${r.context}`);
  const typeUsers = (): string[] =>
    graph.getTypeUsers(symbol).map((e) => `${e.userName} — ${e.userFile}:${e.line} [${e.role}]`);

  switch (relation) {
    case 'callers':
      return [`Callers of \`${symbol}\` (functions that call it):`, '', ...fmtList('callers', callers())].join('\n');
    case 'callees':
      return [`Callees of \`${symbol}\` (what it calls):`, '', ...fmtList('callees', callees())].join('\n');
    case 'references':
      return [`References to \`${symbol}\`:`, '', ...fmtList('references', references())].join('\n');
    case 'type-users':
      return [`Users of type \`${symbol}\`:`, '', ...fmtList('type-users', typeUsers())].join('\n');
    case 'neighborhood': {
      const c = callers();
      const e = callees();
      const r = references();
      const t = typeUsers();
      if (c.length + e.length + r.length + t.length === 0) {
        return `\`${symbol}\` has no edges in the code graph (not found, or a leaf with no recorded callers/callees).`;
      }
      return [
        `Neighborhood of \`${symbol}\`:`,
        '',
        ...fmtList('Called by', c),
        '',
        ...fmtList('Calls', e),
        '',
        ...fmtList('Referenced at', r),
        ...(t.length ? ['', ...fmtList('Used as a type by', t)] : []),
      ].join('\n');
    }
  }
}

export const codeGraphQueryTools: RegisteredTool[] = [
  { definition: queryCodeGraphDef, executor: queryCodeGraph, requiresApproval: false },
];
