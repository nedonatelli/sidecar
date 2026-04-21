/**
 * Doc-to-Test Synthesis Loop (v0.79) — extract structured constraints from
 * reference documents and synthesize pytest test stubs from them.
 *
 * extract_constraints    — parse a doc (md/tex/rst/pdf/text) → typed Constraint[]
 * synthesize_tests       — generate a pytest file from approved constraints
 * classify_test_failure  — triage a failing test → impl_wrong / doc_wrong / extraction_wrong
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../../config/settings.js';
import { getRoot } from './shared.js';
import type { RegisteredTool, ToolExecutorContext } from './shared.js';

// ---------------------------------------------------------------------------
// Constraint type
// ---------------------------------------------------------------------------

export type ConstraintType =
  | 'mathematical_identity'
  | 'numeric_example'
  | 'boundary_condition'
  | 'complexity_bound'
  | 'invariant'
  | 'qualitative_claim';

export interface Constraint {
  id: string;
  type: ConstraintType;
  statement: string;
  /** `"file:page:section — quoted sentence"` provenance string */
  source: string;
  equation?: string;
  testable: boolean;
  confidence: number;
  approved?: boolean;
}

export interface ConstraintExtractionResult {
  constraints: Constraint[];
  docSlug: string;
  truncated: boolean;
}

export interface FailureClassification {
  verdict: 'impl_wrong' | 'doc_wrong' | 'extraction_wrong';
  reasoning: string;
  proposed_fix: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONSTRAINT_TYPES = new Set<string>([
  'mathematical_identity',
  'numeric_example',
  'boundary_condition',
  'complexity_bound',
  'invariant',
  'qualitative_claim',
]);

/** Derive a safe filename slug from a doc path. */
function docSlugFromPath(docPath: string): string {
  return path
    .basename(docPath, path.extname(docPath))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60);
}

/** Validate that a value looks like a Constraint (type guard for LLM output). */
export function isConstraint(v: unknown): v is Constraint {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.type === 'string' &&
    VALID_CONSTRAINT_TYPES.has(c.type) &&
    typeof c.statement === 'string' &&
    typeof c.source === 'string' &&
    typeof c.testable === 'boolean' &&
    typeof c.confidence === 'number'
  );
}

/** Parse constraints JSON out of a possibly markdown-wrapped LLM response. */
export function parseConstraintsFromLlm(raw: string): Constraint[] {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in LLM response');
  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  if (!Array.isArray(parsed.constraints)) {
    throw new Error('Parsed JSON does not contain a "constraints" array');
  }
  return (parsed.constraints as unknown[]).filter(isConstraint);
}

/** Read up to `limit` chars from a plain-text file. Returns [content, truncated]. */
function readTextDoc(filePath: string, limit: number): [string, boolean] {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.length <= limit) return [content, false];
  return [content.slice(0, limit), true];
}

/** Read up to `limit` chars from a PDF using pdf-parse (lazy-loaded). */
async function readPdfDoc(filePath: string, limit: number): Promise<[string, boolean]> {
  let pdfParse: (data: Buffer) => Promise<{ text: string }>;
  try {
    // Lazy require — pdf-parse is an optional external dep.
    pdfParse = require('pdf-parse') as typeof pdfParse;
  } catch {
    throw new Error('pdf-parse is not available. Install it with `npm install pdf-parse`.');
  }
  const data = await pdfParse(fs.readFileSync(filePath));
  const text = data.text;
  if (text.length <= limit) return [text, false];
  return [text.slice(0, limit), true];
}

// ---------------------------------------------------------------------------
// extract_constraints
// ---------------------------------------------------------------------------

async function extractConstraints(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const docPath = input.doc_path as string | undefined;
  const sectionHint = input.section_hint as string | undefined;

  if (!docPath) return 'Error: doc_path is required';

  const client = context?.client;
  if (!client) return 'Error: no SideCarClient available in tool context. This tool requires an active agent session.';

  const config = getConfig();
  const resolvedPath = path.isAbsolute(docPath) ? docPath : path.join(getRoot(), docPath);

  if (!fs.existsSync(resolvedPath)) {
    return `Error: file not found: ${resolvedPath}`;
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const TEXT_LIMIT = 16_000;
  const PDF_LIMIT = 12_000;

  let docContent: string;
  let truncated: boolean;

  try {
    if (ext === '.pdf') {
      [docContent, truncated] = await readPdfDoc(resolvedPath, PDF_LIMIT);
    } else {
      [docContent, truncated] = readTextDoc(resolvedPath, TEXT_LIMIT);
    }
  } catch (err) {
    return `Error reading document: ${String(err)}`;
  }

  const docSlug = docSlugFromPath(resolvedPath);

  const sectionInstruction = sectionHint
    ? `Focus specifically on the section or heading matching: "${sectionHint}". Extract constraints only from that section.`
    : 'Extract constraints from the entire document.';

  const systemPrompt =
    'You are a constraint extractor. Your job is to read a reference document and extract all ' +
    'verifiable constraints — mathematical identities, numeric examples, boundary conditions, ' +
    'complexity bounds, invariants, and qualitative claims — into a structured JSON format.\n\n' +
    'Return ONLY a JSON object with this shape:\n' +
    '{\n' +
    '  "constraints": [\n' +
    '    {\n' +
    '      "id": "c001",\n' +
    '      "type": "mathematical_identity" | "numeric_example" | "boundary_condition" | "complexity_bound" | "invariant" | "qualitative_claim",\n' +
    '      "statement": "human-readable description of what must hold",\n' +
    '      "source": "file:section — quoted sentence or equation from source",\n' +
    '      "equation": "LaTeX equation if applicable (optional)",\n' +
    '      "testable": true | false,\n' +
    '      "confidence": 0.0 to 1.0\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Rules:\n' +
    '- "testable" is false only for qualitative_claim types with no measurable criterion.\n' +
    '- "confidence" reflects how clearly the doc states the constraint (1.0 = explicit formula/value, 0.5 = implied, 0.2 = inferred).\n' +
    '- "source" must quote the exact sentence or equation from the document.\n' +
    '- Assign sequential IDs: c001, c002, ...\n' +
    '- Do not invent constraints not present in the document.\n' +
    '- Include all testable constraints you find, even obvious ones.';

  const userPrompt =
    `Document path: ${resolvedPath}\n` +
    (truncated ? `(Note: document was truncated to ${ext === '.pdf' ? PDF_LIMIT : TEXT_LIMIT} characters)\n` : '') +
    `\n${sectionInstruction}\n\n` +
    `Document content:\n---\n${docContent}\n---`;

  const extractionModel = config.docTestsExtractionModel || undefined;

  let raw: string;
  try {
    raw = await client.completeWithOverrides(
      systemPrompt,
      [{ role: 'user', content: userPrompt }],
      extractionModel,
      2048,
      context?.signal ?? new AbortController().signal,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return 'Extraction aborted.';
    return `Error calling LLM for constraint extraction: ${String(err)}`;
  }

  let constraints: Constraint[];
  try {
    constraints = parseConstraintsFromLlm(raw);
  } catch (err) {
    return `Error parsing LLM response as constraints: ${String(err)}\n\nRaw LLM response:\n${raw}`;
  }

  const result: ConstraintExtractionResult = { constraints, docSlug, truncated };

  const testableCount = constraints.filter((c) => c.testable).length;
  const summary =
    `Extracted ${constraints.length} constraint${constraints.length === 1 ? '' : 's'} ` +
    `(${testableCount} testable) from ${path.basename(resolvedPath)}` +
    (truncated ? ' [document truncated]' : '') +
    '.\n\n' +
    'Review the constraints below. Set `"approved": false` on any you want to exclude before ' +
    'calling `synthesize_tests`. All others will be included.\n\n';

  return summary + JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// synthesize_tests
// ---------------------------------------------------------------------------

async function synthesizeTests(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const constraintsRaw = input.constraints as string | undefined;
  const implContext = input.impl_context as string | undefined;
  const docSlug = input.doc_slug as string | undefined;

  if (!constraintsRaw) return 'Error: constraints is required (JSON string from extract_constraints)';
  if (!docSlug) return 'Error: doc_slug is required';

  const client = context?.client;
  if (!client) return 'Error: no SideCarClient available in tool context. This tool requires an active agent session.';

  const config = getConfig();

  let constraints: Constraint[];
  try {
    const parsed = JSON.parse(constraintsRaw) as unknown;
    const arr = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).constraints;
    if (!Array.isArray(arr)) throw new Error('Expected a JSON array or an object with "constraints" array');
    constraints = (arr as unknown[]).filter(isConstraint);
  } catch (err) {
    return `Error parsing constraints JSON: ${String(err)}`;
  }

  // Filter to approved + testable constraints.
  const active = constraints.filter((c) => c.approved !== false && c.testable);
  if (active.length === 0) {
    return 'No testable constraints to synthesize (all were either non-testable or marked approved: false).';
  }

  const outputDir = config.docTestsOutputDir || 'tests/from_docs';
  const outputPath = path.join(outputDir, docSlug, `test_${docSlug}.py`);
  const floatTol = config.docTestsFloatTolerance ?? 1e-9;

  const constraintList = active
    .map(
      (c) =>
        `- id: ${c.id}, type: ${c.type}, testable: ${c.testable}\n` +
        `  statement: ${c.statement}\n` +
        `  source: ${c.source}` +
        (c.equation ? `\n  equation: ${c.equation}` : ''),
    )
    .join('\n\n');

  const systemPrompt =
    'You are a test synthesis engine. Generate a complete, runnable pytest file from the provided constraints.\n\n' +
    'Follow these synthesis patterns by constraint type:\n' +
    '- mathematical_identity: Use @pytest.mark.parametrize with multiple input/expected pairs. Add a comment suggesting hypothesis strategies.\n' +
    '- numeric_example: Use pytest.approx(expected, rel=FLOAT_TOL) for floating-point comparisons.\n' +
    '- boundary_condition: Write explicit edge-case tests with the exact boundary value in the test name.\n' +
    '- complexity_bound: Write a stub test with a pytest-benchmark comment (do not fail if benchmark not installed).\n' +
    '- invariant: Write an assert-on-call test that verifies the property holds after function invocation.\n\n' +
    'Requirements:\n' +
    "- Each test function must have a docstring with the constraint's source and statement.\n" +
    '- Use descriptive function names: test_<id>_<short_description>.\n' +
    '- Add a FLOAT_TOL = <tolerance> constant at the top of the file.\n' +
    '- Import placeholders (from <module> import <function>) at the top — use the impl_context to infer module paths, or write "# TODO: replace with actual import".\n' +
    '- The file must be valid Python that can be collected by pytest (no syntax errors).\n' +
    '- Return ONLY the Python source file content — no explanation, no markdown fences.\n';

  const userPrompt =
    `Doc slug: ${docSlug}\n` +
    `Output file: ${outputPath}\n` +
    `Float tolerance: ${floatTol}\n` +
    (implContext ? `Implementation context:\n${implContext}\n\n` : '') +
    `Constraints to synthesize (${active.length} total):\n\n${constraintList}`;

  let raw: string;
  try {
    raw = await client.completeWithOverrides(
      systemPrompt,
      [{ role: 'user', content: userPrompt }],
      undefined,
      4096,
      context?.signal ?? new AbortController().signal,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return 'Synthesis aborted.';
    return `Error calling LLM for test synthesis: ${String(err)}`;
  }

  // Strip markdown code fences if the model wrapped the output.
  const stripped = raw
    .replace(/^```(?:python)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  return (
    `Test file synthesized from ${active.length} constraint${active.length === 1 ? '' : 's'}.\n` +
    `Write to: ${outputPath}\n\n` +
    'Use `write_file` to save the content below, then run with `pytest ' +
    path.join(outputDir, docSlug, '/') +
    ' -v`.\n\n' +
    '---\n' +
    stripped
  );
}

// ---------------------------------------------------------------------------
// classify_test_failure
// ---------------------------------------------------------------------------

async function classifyTestFailure(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const testOutput = input.test_output as string | undefined;
  const constraintRaw = input.constraint as string | undefined;
  const implSnippet = input.impl_snippet as string | undefined;

  if (!testOutput) return 'Error: test_output is required';
  if (!constraintRaw) return 'Error: constraint is required (Constraint JSON object)';

  const client = context?.client;
  if (!client) return 'Error: no SideCarClient available in tool context. This tool requires an active agent session.';

  let constraint: Constraint;
  try {
    const parsed = JSON.parse(constraintRaw) as unknown;
    if (!isConstraint(parsed)) throw new Error('Value does not match Constraint shape');
    constraint = parsed;
  } catch (err) {
    return `Error parsing constraint JSON: ${String(err)}`;
  }

  const systemPrompt =
    'You are a test failure classifier. Given a failing pytest test output, the constraint it was synthesized from, ' +
    'and optionally the relevant implementation code, determine the root cause.\n\n' +
    'Return ONLY a JSON object:\n' +
    '{\n' +
    '  "verdict": "impl_wrong" | "doc_wrong" | "extraction_wrong",\n' +
    '  "reasoning": "1-2 sentence explanation of why you chose this verdict",\n' +
    '  "proposed_fix": "concrete, actionable suggestion matching the verdict"\n' +
    '}\n\n' +
    'Verdict semantics:\n' +
    '- impl_wrong: the code does not satisfy the constraint; fix the implementation.\n' +
    "- doc_wrong: the constraint is correct but the document's claim is inaccurate or stale; update the doc.\n" +
    '- extraction_wrong: the constraint was misread from the document; re-extract or correct the constraint statement.';

  const userPrompt =
    `Constraint:\n${JSON.stringify(constraint, null, 2)}\n\n` +
    `Test failure output:\n${testOutput}\n` +
    (implSnippet ? `\nRelevant implementation:\n${implSnippet}\n` : '');

  let raw: string;
  try {
    raw = await client.completeWithOverrides(
      systemPrompt,
      [{ role: 'user', content: userPrompt }],
      undefined,
      512,
      context?.signal ?? new AbortController().signal,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return 'Classification aborted.';
    return `Error calling LLM for failure classification: ${String(err)}`;
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return `LLM response could not be parsed as JSON. Raw response:\n${raw}`;
  }

  let classification: FailureClassification;
  try {
    classification = JSON.parse(jsonMatch[0]) as FailureClassification;
  } catch {
    return `LLM response JSON parse error. Raw response:\n${raw}`;
  }

  const verdictLabel =
    classification.verdict === 'impl_wrong'
      ? '🔴 Implementation is wrong'
      : classification.verdict === 'doc_wrong'
        ? '📄 Document claim is wrong'
        : '🔍 Constraint was mis-extracted';

  return (
    `${verdictLabel}\n\n` +
    `Reasoning: ${classification.reasoning}\n\n` +
    `Proposed fix: ${classification.proposed_fix}\n\n` +
    JSON.stringify(classification)
  );
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const docTestsTools: RegisteredTool[] = [
  {
    definition: {
      name: 'extract_constraints',
      description:
        'Parse a reference document (.md, .tex, .rst, .pdf, or any text file) and extract all verifiable ' +
        'constraints into a structured JSON manifest. Each constraint is typed (mathematical_identity, ' +
        'numeric_example, boundary_condition, complexity_bound, invariant, or qualitative_claim) and ' +
        'includes a provenance string quoting the exact source sentence. ' +
        'Returns { constraints: Constraint[], docSlug, truncated } as JSON. ' +
        'Review the constraints in chat, set approved:false on any to exclude, then pass to synthesize_tests. ' +
        'Example: `extract_constraints(doc_path="docs/spec.md", section_hint="Error bounds")`.',
      input_schema: {
        type: 'object',
        properties: {
          doc_path: {
            type: 'string',
            description:
              'Path to the document (absolute, or relative to workspace root). Supports .md, .tex, .rst, .pdf, and plain text.',
          },
          section_hint: {
            type: 'string',
            description: 'Optional heading or section name to focus extraction on. Useful for large documents.',
          },
        },
        required: ['doc_path'],
      },
    },
    executor: extractConstraints,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'synthesize_tests',
      description:
        'Generate a complete pytest test file from a Constraint[] manifest (output of extract_constraints). ' +
        'Filters to approved (approved !== false) and testable constraints. ' +
        'Maps each constraint type to an appropriate pytest pattern: parametrize + hypothesis for math ' +
        'identities, pytest.approx for numeric examples, edge-case tests for boundary conditions, ' +
        'benchmark stubs for complexity bounds, assert-on-call for invariants. ' +
        'Returns the generated Python source as a string — use write_file to save it, then run with pytest. ' +
        'Example: `synthesize_tests(constraints=<JSON string>, doc_slug="spec", impl_context="src/dsp.py")`.',
      input_schema: {
        type: 'object',
        properties: {
          constraints: {
            type: 'string',
            description:
              'JSON string — either a Constraint[] array or the full ConstraintExtractionResult from extract_constraints.',
          },
          doc_slug: {
            type: 'string',
            description: 'Short identifier for the document (used in the output file path and test module name).',
          },
          impl_context: {
            type: 'string',
            description:
              'Optional: file paths or description of the implementation being tested. Helps the synthesizer pick correct import paths.',
          },
        },
        required: ['constraints', 'doc_slug'],
      },
    },
    executor: synthesizeTests,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'classify_test_failure',
      description:
        'Classify a failing pytest test back to its root cause: impl_wrong (the code disagrees with the ' +
        "constraint), doc_wrong (the document's claim is inaccurate), or extraction_wrong (the constraint " +
        'was misread from the document). Accepts the pytest output for a single failing test plus the ' +
        'Constraint JSON that generated it. Optionally include the relevant implementation snippet for ' +
        'better accuracy. Returns { verdict, reasoning, proposed_fix } as JSON plus a human-readable summary. ' +
        'Example: `classify_test_failure(test_output="FAILED test_c001...", constraint=<JSON>)`.',
      input_schema: {
        type: 'object',
        properties: {
          test_output: {
            type: 'string',
            description: 'The pytest output for a single failing test (the FAILED block from pytest -v output).',
          },
          constraint: {
            type: 'string',
            description: 'JSON string of the Constraint object that the failing test was synthesized from.',
          },
          impl_snippet: {
            type: 'string',
            description:
              'Optional: the relevant implementation code block being tested. Improves classification accuracy.',
          },
        },
        required: ['test_output', 'constraint'],
      },
    },
    executor: classifyTestFailure,
    requiresApproval: false,
  },
];
