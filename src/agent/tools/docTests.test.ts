import { describe, it, expect } from 'vitest';
import { isConstraint, parseConstraintsFromLlm, docTestsTools } from './docTests.js';
import type { Constraint } from './docTests.js';

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
