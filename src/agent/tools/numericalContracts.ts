import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { getRoot } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import { findNumericalKernels, type NumericalKernel, type SourceReader } from '../numericalContracts.js';

/**
 * `check_numerical_contracts` — list numerical kernels (functions touching
 * arrays/quantities) and flag the ones lacking a shape/dtype/unit contract.
 * Rides on the code graph's type-flow edges. The complement to a passing test
 * suite: "tests pass" says nothing about whether a bare `np.ndarray` has the
 * right shape — this finds where that's unstated.
 */

const KIND_MARK: Record<NonNullable<NumericalKernel['contractKind']>, string> = {
  'shaped-type': 'shaped type',
  assertion: 'shape/dtype assertion',
  docstring: 'docstring spec',
};
const MAX_LISTED = 40;

export const checkNumericalContractsDef: ToolDefinition = {
  name: 'check_numerical_contracts',
  description:
    'List numerical kernels (functions with array/tensor/quantity parameters or returns — e.g. np.ndarray) and flag those ' +
    'that lack a shape/dtype/unit contract (a shaped type annotation, a shape/dtype assertion, or a docstring shape spec). ' +
    'Use after editing numerical/scientific code to confirm the array contracts are stated, not just that tests pass. ' +
    'Pass `file` (relative path) to scope to one file, or omit to scan the workspace. ' +
    'Example: `check_numerical_contracts(file="src/geometry.py")`.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path to scope the scan to a single file.' },
      onlyUncontracted: { type: 'boolean', description: 'List only kernels missing a contract. Default: false.' },
    },
    required: [],
  },
};

export async function checkNumericalContracts(input: Record<string, unknown>): Promise<string> {
  const graph = getDefaultToolRuntime().symbolGraph;
  if (!graph || graph.fileCount() === 0) {
    return 'Symbol graph not available yet (workspace still indexing). Retry shortly.';
  }
  const root = getRoot();
  const file = typeof input.file === 'string' && input.file.trim() ? input.file.trim() : undefined;
  const onlyUncontracted = input.onlyUncontracted === true;

  const readSource: SourceReader = (f) => {
    const cached = graph.getFileContent(f);
    if (cached) return cached;
    try {
      return fs.readFileSync(root && !path.isAbsolute(f) ? path.join(root, f) : f, 'utf-8');
    } catch {
      return undefined;
    }
  };

  const kernels = findNumericalKernels(graph, readSource, file ? { fileFilter: (f) => f === file } : undefined);
  if (kernels.length === 0) {
    return file
      ? `No numerical kernels found in "${file}" (no functions with array/quantity-typed parameters or returns).`
      : 'No numerical kernels found in the workspace.';
  }

  const missing = kernels.filter((k) => !k.hasContract);
  const shown = onlyUncontracted ? missing : kernels;
  const scope = file ?? 'workspace';
  const header =
    `${kernels.length} numerical kernel${kernels.length === 1 ? '' : 's'} in ${scope} — ` +
    `${missing.length} missing a shape/dtype/unit contract:`;

  const lines = shown.slice(0, MAX_LISTED).map((k) => {
    const loc = `${k.file}:${k.startLine}`;
    if (k.hasContract) return `- ✓ ${k.name} (${loc}) — ${KIND_MARK[k.contractKind!]}`;
    return `- ⚠ ${k.name} (${loc}) — no contract (${k.roles.join('/')} typed as a bare array)`;
  });
  if (shown.length > MAX_LISTED) lines.push(`- …and ${shown.length - MAX_LISTED} more`);

  const footer = missing.length
    ? '\nAdd a shaped type (e.g. `npt.NDArray[np.float64]` / nptyping `Shape[...]`), a `assert arr.shape == …` / dtype check, or a docstring shape spec to the flagged kernels.'
    : '\nAll numerical kernels declare a contract.';

  return [header, '', ...lines, footer].join('\n');
}

export const numericalContractsTools: RegisteredTool[] = [
  { definition: checkNumericalContractsDef, executor: checkNumericalContracts, requiresApproval: false },
];
