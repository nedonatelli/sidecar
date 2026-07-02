import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { getRoot } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import { synthesizeHypothesisTest, parsePropertyDeclarations } from '../propertyTests.js';

// ---------------------------------------------------------------------------
// `synthesize_property_test` — §5 vertical, pillar 3 ("prove the math").
//
// Given a numerical kernel that DECLARES invariants (`# property: symmetric`,
// `# property: idempotent`, `# bounds: 0 <= result <= 1`, `# invariant: …`),
// generate a complete, runnable Hypothesis property test: random inputs, the
// declared assertions, ready to save + run under pytest. A property test is the
// generalization of the analytic-bound gate — it tries to VIOLATE the stated
// math across many inputs, not just check one.
// ---------------------------------------------------------------------------

/** `src/geometry.py` → `src.geometry` (best-effort dotted import path). */
function moduleFromFile(file: string): string {
  return file
    .replace(/\.(py)$/, '')
    .replace(/^\.\//, '')
    .split(/[/\\]/)
    .filter(Boolean)
    .join('.');
}

export const synthesizePropertyTestDef: ToolDefinition = {
  name: 'synthesize_property_test',
  description:
    'Generate a runnable Hypothesis property-based test for a numerical kernel that DECLARES invariants in ' +
    'comments — `# property: symmetric` / `idempotent` / `monotonic` / `non-negative`, `# bounds: 0 <= result <= 1`, ' +
    'or `# invariant: sum(result) == sum(x)`. Returns a complete test (random-input strategies + the declared ' +
    'assertions) that tries to violate the math across many inputs — the generalization of a single bound check. ' +
    'Declare the properties on the function first, then call this. ' +
    'Example: `synthesize_property_test(file="src/geometry.py", function="rotate")`.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path to the source file containing the kernel.' },
      function: { type: 'string', description: 'Name of the function to synthesize a property test for.' },
      max_examples: { type: 'number', description: 'Hypothesis max_examples (default 100).' },
    },
    required: ['file', 'function'],
  },
};

export async function synthesizePropertyTest(input: Record<string, unknown>): Promise<string> {
  const file = typeof input.file === 'string' ? input.file.trim() : '';
  const func = typeof input.function === 'string' ? input.function.trim() : '';
  if (!file || !func) return 'Error: both `file` and `function` are required.';

  const graph = getDefaultToolRuntime().symbolGraph;
  if (!graph || graph.fileCount() === 0) {
    return 'Symbol graph not available yet (workspace still indexing). Retry shortly.';
  }
  const root = getRoot();
  const readSource = (f: string): string | undefined => {
    const cached = graph.getFileContent(f);
    if (cached) return cached;
    try {
      return fs.readFileSync(root && !path.isAbsolute(f) ? path.join(root, f) : f, 'utf-8');
    } catch {
      return undefined;
    }
  };

  const content = readSource(file);
  if (!content) return `Error: could not read "${file}".`;
  const sym = graph.getSymbolsInFile(file).find((s) => s.name === func);
  if (!sym) return `Error: function "${func}" not found in "${file}".`;

  const slice = content
    .split('\n')
    .slice(sym.startLine, sym.endLine + 1)
    .join('\n');
  const declared = parsePropertyDeclarations(slice);
  if (declared.length === 0) {
    return (
      `\`${func}\` declares no properties, so there is nothing to test. Add an invariant the function must ` +
      `satisfy for ALL inputs as a comment, then retry — e.g.:\n` +
      '  `# property: symmetric` (f(a,b)==f(b,a))\n' +
      '  `# property: idempotent` (f(f(x))==f(x))\n' +
      '  `# bounds: 0 <= result <= 1`\n' +
      '  `# invariant: np.isclose(np.sum(result), np.sum(x))`'
    );
  }

  const maxExamples =
    typeof input.max_examples === 'number' && input.max_examples > 0 ? Math.floor(input.max_examples) : 100;
  const test = synthesizeHypothesisTest(func, slice, { module: moduleFromFile(file), maxExamples });

  const kinds = declared.map((d) => d.kind).join(', ');
  return [
    `Synthesized a Hypothesis property test for \`${func}\` (${declared.length} propert${declared.length === 1 ? 'y' : 'ies'}: ${kinds}).`,
    `Save it as \`test_${func}_properties.py\` and run \`pytest\` (needs \`hypothesis\`):`,
    '',
    '```python',
    test?.trimEnd() ?? '',
    '```',
  ].join('\n');
}

export const propertyTestTools: RegisteredTool[] = [
  { definition: synthesizePropertyTestDef, executor: synthesizePropertyTest, requiresApproval: false },
];
