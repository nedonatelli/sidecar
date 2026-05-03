import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isConstraint, parseConstraintsFromLlm, docTestsTools } from './docTests.js';
import type { Constraint } from './docTests.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    docTestsExtractionModel: undefined,
    docTestsOutputDir: undefined,
    docTestsFloatTolerance: undefined,
  }),
}));

vi.mock('./shared.js', async () => {
  const actual = await vi.importActual<typeof import('./shared.js')>('./shared.js');
  return { ...actual, getRoot: vi.fn().mockReturnValue('/workspace') };
});

import * as fsMod from 'fs';
const mockExistsSync = vi.mocked(fsMod.existsSync);
const mockReadFileSync = vi.mocked(fsMod.readFileSync);

// ---------------------------------------------------------------------------
// isConstraint type guard
// ---------------------------------------------------------------------------

describe('isConstraint', () => {
  const valid: Constraint = {
    id: 'c001',
    type: 'mathematical_identity',
    statement: 'The sum of angles in a triangle equals 180 degrees.',
    source: 'spec.md:section 2 — "sum of angles equals 180"',
    testable: true,
    confidence: 0.95,
  };

  it('accepts a fully valid Constraint', () => {
    expect(isConstraint(valid)).toBe(true);
  });

  it('accepts a Constraint with optional fields', () => {
    expect(isConstraint({ ...valid, equation: '\\alpha + \\beta + \\gamma = 180', approved: true })).toBe(true);
  });

  it('rejects null', () => {
    expect(isConstraint(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isConstraint('string')).toBe(false);
    expect(isConstraint(42)).toBe(false);
  });

  it('rejects when id is missing', () => {
    const { id: _id, ...rest } = valid;
    expect(isConstraint(rest)).toBe(false);
  });

  it('rejects when type is not a valid ConstraintType', () => {
    expect(isConstraint({ ...valid, type: 'unknown_type' })).toBe(false);
  });

  it('rejects when testable is not boolean', () => {
    expect(isConstraint({ ...valid, testable: 'yes' })).toBe(false);
  });

  it('rejects when confidence is not a number', () => {
    expect(isConstraint({ ...valid, confidence: 'high' })).toBe(false);
  });

  it('accepts all valid ConstraintType values', () => {
    const types = [
      'mathematical_identity',
      'numeric_example',
      'boundary_condition',
      'complexity_bound',
      'invariant',
      'qualitative_claim',
    ] as const;
    for (const type of types) {
      expect(isConstraint({ ...valid, type })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseConstraintsFromLlm
// ---------------------------------------------------------------------------

describe('parseConstraintsFromLlm', () => {
  const sampleConstraint: Constraint = {
    id: 'c001',
    type: 'numeric_example',
    statement: 'log2(8) equals 3',
    source: 'math.md — "log2(8) = 3"',
    testable: true,
    confidence: 1.0,
  };

  it('parses a bare JSON object string', () => {
    const raw = JSON.stringify({ constraints: [sampleConstraint] });
    const result = parseConstraintsFromLlm(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c001');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({ constraints: [sampleConstraint] }) + '\n```';
    const result = parseConstraintsFromLlm(raw);
    expect(result).toHaveLength(1);
  });

  it('filters out invalid constraint entries silently', () => {
    const raw = JSON.stringify({
      constraints: [
        sampleConstraint,
        { id: 'bad', type: 'not_a_type', statement: 'x', source: 'y', testable: true, confidence: 0.5 },
      ],
    });
    const result = parseConstraintsFromLlm(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c001');
  });

  it('returns empty array when constraints array is empty', () => {
    const raw = JSON.stringify({ constraints: [] });
    expect(parseConstraintsFromLlm(raw)).toEqual([]);
  });

  it('throws when there is no JSON object in the response', () => {
    expect(() => parseConstraintsFromLlm('No JSON here at all.')).toThrow();
  });

  it('throws when the JSON has no constraints field', () => {
    expect(() => parseConstraintsFromLlm(JSON.stringify({ data: [] }))).toThrow(/constraints/);
  });
});

// ---------------------------------------------------------------------------
// docTestsTools registry
// ---------------------------------------------------------------------------

describe('docTestsTools registry', () => {
  it('exports exactly 3 tools', () => {
    expect(docTestsTools).toHaveLength(3);
  });

  it('tool names are extract_constraints, synthesize_tests, classify_test_failure', () => {
    const names = docTestsTools.map((t) => t.definition.name);
    expect(names).toContain('extract_constraints');
    expect(names).toContain('synthesize_tests');
    expect(names).toContain('classify_test_failure');
  });

  it('no tool requires approval', () => {
    for (const tool of docTestsTools) {
      expect(tool.requiresApproval ?? false).toBe(false);
      expect((tool as { alwaysRequireApproval?: boolean }).alwaysRequireApproval ?? false).toBe(false);
    }
  });

  it('all tools have descriptions of at least 150 characters', () => {
    for (const tool of docTestsTools) {
      expect(
        tool.definition.description.length,
        `${tool.definition.name} description too short`,
      ).toBeGreaterThanOrEqual(150);
    }
  });

  it('required fields are correct for each tool', () => {
    const requiredMap: Record<string, string[]> = {
      extract_constraints: ['doc_path'],
      synthesize_tests: ['constraints', 'doc_slug'],
      classify_test_failure: ['test_output', 'constraint'],
    };
    for (const tool of docTestsTools) {
      const schema = tool.definition.input_schema as { required?: string[] };
      expect(schema.required, `${tool.definition.name} required mismatch`).toEqual(requiredMap[tool.definition.name]);
    }
  });
});

// ---------------------------------------------------------------------------
// Executor helpers
// ---------------------------------------------------------------------------

function getExecutor(name: string) {
  const tool = docTestsTools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.executor;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(responseText = '{"constraints":[]}'): any {
  return {
    completeWithOverrides: vi.fn().mockResolvedValue(responseText),
  };
}

function makeConstraint(overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: 'c001',
    type: 'numeric_example',
    statement: 'log2(8) equals 3',
    source: 'math.md — "log2(8) = 3"',
    testable: true,
    confidence: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractConstraints executor
// ---------------------------------------------------------------------------

describe('extractConstraints executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('doc content' as never);
  });

  it('returns error when doc_path is missing', async () => {
    const exec = getExecutor('extract_constraints');
    const result = await exec({}, undefined);
    expect(result).toContain('doc_path is required');
  });

  it('returns error when no client in context', async () => {
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, undefined);
    expect(result).toContain('no SideCarClient available');
  });

  it('returns error when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'missing.md' }, { client: makeClient() } as never);
    expect(result).toContain('file not found');
  });

  it('returns extracted constraints summary on success', async () => {
    const constraint = makeConstraint();
    const client = makeClient(JSON.stringify({ constraints: [constraint] }));
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, { client } as never);
    expect(result).toContain('Extracted 1 constraint');
    expect(result).toContain('"docSlug"');
  });

  it('returns error when readFileSync throws', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, { client: makeClient() } as never);
    expect(result).toContain('Error reading document');
  });

  it('returns error when LLM throws', async () => {
    const client = { completeWithOverrides: vi.fn().mockRejectedValue(new Error('timeout')) } as never;
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, { client } as never);
    expect(result).toContain('Error calling LLM');
  });

  it('returns aborted message on AbortError', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = { completeWithOverrides: vi.fn().mockRejectedValue(err) } as never;
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, { client } as never);
    expect(result).toBe('Extraction aborted.');
  });

  it('returns error when LLM response is not parseable JSON constraints', async () => {
    const client = makeClient('This is just text, no JSON');
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, { client } as never);
    expect(result).toContain('Error parsing LLM response');
  });

  it('includes truncation note when doc is long', async () => {
    mockReadFileSync.mockReturnValue('x'.repeat(20000) as never);
    const constraint = makeConstraint();
    const client = makeClient(JSON.stringify({ constraints: [constraint] }));
    const exec = getExecutor('extract_constraints');
    const result = await exec({ doc_path: 'docs/spec.md' }, { client } as never);
    expect(result).toContain('truncated');
  });

  it('uses section_hint in extraction when provided', async () => {
    const constraint = makeConstraint();
    const client = makeClient(JSON.stringify({ constraints: [constraint] }));
    const exec = getExecutor('extract_constraints');
    await exec({ doc_path: 'docs/spec.md', section_hint: 'Error bounds' }, { client } as never);
    const prompt = vi.mocked(client.completeWithOverrides).mock.calls[0][1][0].content;
    expect(prompt).toContain('Error bounds');
  });
});

// ---------------------------------------------------------------------------
// synthesizeTests executor
// ---------------------------------------------------------------------------

describe('synthesizeTests executor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when constraints is missing', async () => {
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ doc_slug: 'spec' }, undefined);
    expect(result).toContain('constraints is required');
  });

  it('returns error when doc_slug is missing', async () => {
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: '[]' }, undefined);
    expect(result).toContain('doc_slug is required');
  });

  it('returns error when no client in context', async () => {
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: '[]', doc_slug: 'spec' }, undefined);
    expect(result).toContain('no SideCarClient available');
  });

  it('returns error when constraints JSON is invalid', async () => {
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: 'not json', doc_slug: 'spec' }, { client: makeClient() } as never);
    expect(result).toContain('Error parsing constraints JSON');
  });

  it('returns message when no testable constraints remain', async () => {
    const constraint = makeConstraint({ testable: false });
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify([constraint]), doc_slug: 'spec' }, {
      client: makeClient(),
    } as never);
    expect(result).toContain('No testable constraints');
  });

  it('returns message when all constraints are approved:false', async () => {
    const constraint = makeConstraint({ approved: false });
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify([constraint]), doc_slug: 'spec' }, {
      client: makeClient(),
    } as never);
    expect(result).toContain('No testable constraints');
  });

  it('returns synthesized test file on success', async () => {
    const constraint = makeConstraint();
    const client = makeClient('import pytest\n\ndef test_c001(): pass');
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify([constraint]), doc_slug: 'spec' }, { client } as never);
    expect(result).toContain('Test file synthesized');
    expect(result).toContain('Write to:');
  });

  it('returns aborted message on AbortError', async () => {
    const constraint = makeConstraint();
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = { completeWithOverrides: vi.fn().mockRejectedValue(err) } as never;
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify([constraint]), doc_slug: 'spec' }, { client } as never);
    expect(result).toBe('Synthesis aborted.');
  });

  it('returns error when LLM throws', async () => {
    const constraint = makeConstraint();
    const client = { completeWithOverrides: vi.fn().mockRejectedValue(new Error('network')) } as never;
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify([constraint]), doc_slug: 'spec' }, { client } as never);
    expect(result).toContain('Error calling LLM');
  });

  it('accepts constraints wrapped in ConstraintExtractionResult shape', async () => {
    const constraint = makeConstraint();
    const wrapped = { constraints: [constraint], docSlug: 'spec', truncated: false };
    const client = makeClient('def test_c001(): pass');
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify(wrapped), doc_slug: 'spec' }, { client } as never);
    expect(result).toContain('Test file synthesized');
  });

  it('strips markdown code fences from LLM response', async () => {
    const constraint = makeConstraint();
    const client = makeClient('```python\ndef test_c001(): pass\n```');
    const exec = getExecutor('synthesize_tests');
    const result = await exec({ constraints: JSON.stringify([constraint]), doc_slug: 'spec' }, { client } as never);
    expect(result).not.toContain('```');
  });
});

// ---------------------------------------------------------------------------
// classifyTestFailure executor
// ---------------------------------------------------------------------------

describe('classifyTestFailure executor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when test_output is missing', async () => {
    const exec = getExecutor('classify_test_failure');
    const result = await exec({}, undefined);
    expect(result).toContain('test_output is required');
  });

  it('returns error when constraint is missing', async () => {
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED test_c001' }, undefined);
    expect(result).toContain('constraint is required');
  });

  it('returns error when no client in context', async () => {
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()) }, undefined);
    expect(result).toContain('no SideCarClient available');
  });

  it('returns error when constraint JSON is invalid', async () => {
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: 'not json' }, { client: makeClient() } as never);
    expect(result).toContain('Error parsing constraint JSON');
  });

  it('returns error when constraint does not match shape', async () => {
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: '{"id": "c001"}' }, {
      client: makeClient(),
    } as never);
    expect(result).toContain('Error parsing constraint JSON');
  });

  it('returns classification result on success', async () => {
    const classification = { verdict: 'impl_wrong', reasoning: 'code is wrong', proposed_fix: 'fix it' };
    const client = makeClient(JSON.stringify(classification));
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED test_c001', constraint: JSON.stringify(makeConstraint()) }, {
      client,
    } as never);
    expect(result).toContain('Implementation is wrong');
    expect(result).toContain('code is wrong');
  });

  it('returns correct label for doc_wrong verdict', async () => {
    const classification = { verdict: 'doc_wrong', reasoning: 'doc is stale', proposed_fix: 'update doc' };
    const client = makeClient(JSON.stringify(classification));
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()) }, {
      client,
    } as never);
    expect(result).toContain('Document claim is wrong');
  });

  it('returns correct label for extraction_wrong verdict', async () => {
    const classification = { verdict: 'extraction_wrong', reasoning: 'misread', proposed_fix: 're-extract' };
    const client = makeClient(JSON.stringify(classification));
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()) }, {
      client,
    } as never);
    expect(result).toContain('mis-extracted');
  });

  it('returns error when LLM response has no JSON', async () => {
    const client = makeClient('no json here');
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()) }, {
      client,
    } as never);
    expect(result).toContain('could not be parsed as JSON');
  });

  it('returns aborted message on AbortError', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = { completeWithOverrides: vi.fn().mockRejectedValue(err) } as never;
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()) }, {
      client,
    } as never);
    expect(result).toBe('Classification aborted.');
  });

  it('returns error when LLM throws', async () => {
    const client = { completeWithOverrides: vi.fn().mockRejectedValue(new Error('oops')) } as never;
    const exec = getExecutor('classify_test_failure');
    const result = await exec({ test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()) }, {
      client,
    } as never);
    expect(result).toContain('Error calling LLM');
  });

  it('includes impl_snippet in the prompt when provided', async () => {
    const classification = { verdict: 'impl_wrong', reasoning: 'r', proposed_fix: 'f' };
    const client = makeClient(JSON.stringify(classification));
    const exec = getExecutor('classify_test_failure');
    await exec(
      { test_output: 'FAILED', constraint: JSON.stringify(makeConstraint()), impl_snippet: 'def foo(): return 1' },
      { client } as never,
    );
    const prompt = vi.mocked(client.completeWithOverrides).mock.calls[0][1][0].content;
    expect(prompt).toContain('def foo(): return 1');
  });
});
