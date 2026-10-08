import * as path from 'path';
import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { resolveRootUri, type ToolExecutorContext, type RegisteredTool } from './shared.js';
import { getConfig } from '../../config/settings.js';
import { runVerificationCommand } from './shell.js';
import { runMutationTest, type MutationIo } from '../mutation/mutationRunner.js';
import { formatMutationScore } from '../mutation/mutationScore.js';
import type { Mutant } from '../mutation/mutationOperators.js';

// ---------------------------------------------------------------------------
// `mutation_test` agent tool — verify-the-verifier (scaffolding roadmap #3).
//
// Given a source file + the command that tests it, seed single-point mutations
// and report which SURVIVE (the test still passes) — proof the tests would miss
// that class of bug. Where the behavioral-verification gate only checks that a
// test *references* the module, this proves the test would *catch a change*.
//
// Bounded by design: a mutant cap and a per-test-run timeout, because it runs
// the test command once per mutant. The original file is always restored (the
// runner's finally), even on abort/throw.
// ---------------------------------------------------------------------------

type MutationOperator = Mutant['operator'];
const VALID_OPERATORS: readonly MutationOperator[] = ['relational', 'arithmetic', 'logical', 'boolean-literal'];

async function mutationTest(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const file = typeof input.file === 'string' ? input.file.trim() : '';
  const testCommand = typeof input.test_command === 'string' ? input.test_command.trim() : '';
  if (!file) return 'Error: `file` is required (the source file to mutate).';
  if (!testCommand) return 'Error: `test_command` is required (the command that runs this file’s tests).';

  const cfg = getConfig();
  const maxMutants =
    typeof input.max_mutants === 'number' && input.max_mutants > 0
      ? Math.floor(input.max_mutants)
      : cfg.mutationMaxMutants;
  const operators =
    Array.isArray(input.operators) && input.operators.length > 0
      ? input.operators.filter((o): o is MutationOperator => VALID_OPERATORS.includes(o as MutationOperator))
      : undefined;
  const perTestTimeoutMs = cfg.mutationTestTimeoutMs;
  const signal = context?.signal;

  const rootUri = resolveRootUri(context);
  const uriFor = (p: string): Uri => (path.isAbsolute(p) ? Uri.file(p) : Uri.joinPath(rootUri, p));

  // The original's exact bytes, for the restore. Decoding and re-encoding as
  // UTF-8 permanently changed a Latin-1, cp1252 or UTF-16 file; such a file is
  // refused, since every mutant written would re-encode it the same way.
  let original: { text: string; bytes: Uint8Array } | undefined;
  const io: MutationIo = {
    async read(p: string): Promise<string> {
      const bytes = await workspace.fs.readFile(uriFor(p));
      const text = Buffer.from(bytes).toString('utf-8');
      if (!original) {
        if (!Buffer.from(text, 'utf-8').equals(Buffer.from(bytes))) {
          throw new Error(`${file} is not UTF-8 text, and writing a mutant would re-encode it.`);
        }
        original = { text, bytes };
      }
      return text;
    },
    async write(p: string, content: string): Promise<void> {
      const bytes = original && content === original.text ? original.bytes : Buffer.from(content, 'utf-8');
      await workspace.fs.writeFile(uriFor(p), bytes);
    },
    async runTest(): Promise<{ passed: boolean; output: string }> {
      const r = await runVerificationCommand(testCommand, perTestTimeoutMs, signal);
      return { passed: r.exitCode === 0 && !r.timedOut, output: r.output };
    },
  };

  let run;
  try {
    run = await runMutationTest(file, io, { operators, maxMutants, signal });
  } catch (err) {
    return `Error: mutation test failed to run: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (run.stopped && run.results.length === 0) return `Mutation testing of \`${file}\` was stopped.`;
  if (!run.baselinePassed) {
    return (
      `Mutation testing skipped for \`${file}\`: the baseline test command did not pass on the ORIGINAL file. ` +
      `Mutation testing is only meaningful against a green baseline — make \`${testCommand}\` pass first, then retry.`
    );
  }

  const s = run.score;
  const lines: string[] = [`**Mutation test — \`${file}\`**`, '', formatMutationScore(s)];
  if (run.stopped) lines.push('', `Stopped after ${run.results.length} mutant(s); the score covers only those.`);
  if (s.viable === 0) {
    lines.push('', 'No viable mutants were generated (no mutable operators found in this file).');
    return lines.join('\n');
  }

  if (s.survivors.length === 0) {
    lines.push('', `✅ All ${s.killed} mutants killed — the test catches every seeded fault in this file.`);
  } else {
    lines.push(
      '',
      `⚠️ ${s.survivors.length} surviving mutant(s) — the test PASSED with these faults injected, so it would ` +
        `miss this class of bug. Add assertions that would fail on each:`,
      '',
      ...s.survivors.slice(0, 20).map((r) => `- \`${file}:${r.mutant.line}\` — ${r.mutant.description}`),
    );
    if (s.survivors.length > 20) lines.push(`- …and ${s.survivors.length - 20} more.`);
  }
  return lines.join('\n');
}

export const mutationTestDef: ToolDefinition = {
  name: 'mutation_test',
  nondeterministicOutput: true,
  description:
    'Measure how good a test suite actually is by mutation testing: seed small faults into a source file ' +
    '(flip `<`→`>=`, `+`→`-`, `and`→`or`, `true`→`false`) and report which SURVIVE — i.e. the test still ' +
    'passes, proving it would miss that bug. Use to verify a test genuinely exercises the code (not a hollow ' +
    'test), or to find coverage gaps. Requires a GREEN baseline. Runs the test once per mutant, so it is ' +
    'bounded by a mutant cap. Example: `mutation_test(file="src/calc.py", test_command="pytest test_calc.py -q")`.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Source file to mutate (relative to the workspace root, or absolute).' },
      test_command: {
        type: 'string',
        description: 'Command that runs the tests covering `file`. Must exit 0 on the unmodified file.',
      },
      operators: {
        type: 'array',
        items: { type: 'string', enum: ['relational', 'arithmetic', 'logical', 'boolean-literal'] },
        description: 'Restrict to these mutation operator categories. Defaults to all four.',
      },
      max_mutants: {
        type: 'number',
        description: 'Cap on mutants generated/tested (bounds runtime). Defaults to sidecar.mutation.maxMutants.',
      },
    },
    required: ['file', 'test_command'],
  },
};

export const mutationTools: RegisteredTool[] = [
  { definition: mutationTestDef, executor: mutationTest, requiresApproval: true },
];
