import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { getRoot } from './shared.js';
import { requireSymbolGraph, makeGraphSourceReader, SYMBOL_GRAPH_UNAVAILABLE } from './graphToolSupport.js';
import { checkShapeConsistency } from '../shapePropagation.js';

/**
 * `check_shape_consistency` — propagate shape/dtype contracts and flag the
 * provable conflicts: a parameter whose annotation and `assert x.shape == …`
 * disagree (intra-kernel), and `def f(...): return g(...)` where f and g declare
 * different return shapes (tail-call). Rides on the code graph's call edges +
 * the shape parser. Complements `check_numerical_contracts` ("are contracts
 * stated?") by checking the stated contracts actually agree.
 */

const MAX_LISTED = 40;

export const checkShapeConsistencyDef: ToolDefinition = {
  name: 'check_shape_consistency',
  description:
    'Check that the shape/dtype contracts on numerical functions are internally consistent: a parameter whose type ' +
    'annotation and `assert x.shape == …` disagree, or `def f(...): return g(...)` where f and g declare different ' +
    'return shapes. Use after adding or editing array shape contracts. Symbolic dims (N) are treated as wildcards, so ' +
    'only provable conflicts (rank, conflicting literal dims, dtype) are reported. Pass `file` to scope to one file. ' +
    'Example: `check_shape_consistency(file="src/geometry.py")`.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path to scope the check to a single file.' },
    },
    required: [],
  },
};

export async function checkShapeConsistencyTool(input: Record<string, unknown>): Promise<string> {
  const graph = requireSymbolGraph();
  if (!graph || graph.fileCount() === 0) {
    return SYMBOL_GRAPH_UNAVAILABLE;
  }
  const file = typeof input.file === 'string' && input.file.trim() ? input.file.trim() : undefined;

  const readSource = makeGraphSourceReader(graph, getRoot());

  const issues = checkShapeConsistency(graph, readSource, file ? { fileFilter: (f) => f === file } : undefined);
  const scope = file ?? 'workspace';
  if (issues.length === 0) {
    return `No shape-contract conflicts found in ${scope}. (Symbolic dims are wildcards, so only provable conflicts are reported.)`;
  }

  const lines = issues
    .slice(0, MAX_LISTED)
    .map((i) => `- ⚠ ${i.kernel} (${i.file}:${i.line}) [${i.kind}] — ${i.detail}`);
  if (issues.length > MAX_LISTED) lines.push(`- …and ${issues.length - MAX_LISTED} more`);

  return [
    `${issues.length} shape-contract conflict${issues.length === 1 ? '' : 's'} in ${scope}:`,
    '',
    ...lines,
    '\nReconcile the disagreeing shapes — fix the annotation, the assertion, or the contract on the called function.',
  ].join('\n');
}

export const shapeConsistencyTools: RegisteredTool[] = [
  { definition: checkShapeConsistencyDef, executor: checkShapeConsistencyTool, requiresApproval: false },
];
