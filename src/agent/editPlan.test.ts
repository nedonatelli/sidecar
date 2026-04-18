import { describe, it, expect } from 'vitest';
import {
  validateEditPlan,
  normalizeEditPlan,
  layerPlan,
  planToLayers,
  parseEditPlanJson,
  EditPlanValidationError,
  type EditPlan,
  type PlannedEdit,
} from './editPlan.js';

// ---------------------------------------------------------------------------
// Tests for editPlan.ts (v0.65 chunk 4.1).
//
// EditPlan is the typed manifest behind Multi-File Edit Streams: the
// planner agent emits one; the runtime validates + layers it; the
// scheduler walks the layers. These tests pin:
//   - validateEditPlan rejection reasons (each returns a typed
//     `reason` so planner-feedback can tailor retry prompts)
//   - layerPlan topological correctness + parallelism contract
//     (independent nodes collapse into one layer, not N serialized
//     layers)
//   - parseEditPlanJson defensive-parse behavior for model output
//     (accepts both `{edits:[...]}` and bare `[...]`)
// ---------------------------------------------------------------------------

function edit(path: string, op: 'create' | 'edit' | 'delete' = 'edit', dependsOn: string[] = []): PlannedEdit {
  return { path, op, rationale: `work on ${path}`, dependsOn };
}

describe('validateEditPlan — happy paths', () => {
  it('accepts a plan with one edit', () => {
    expect(() => validateEditPlan({ edits: [edit('a.ts')] })).not.toThrow();
  });

  it('accepts multiple independent edits', () => {
    expect(() => validateEditPlan({ edits: [edit('a.ts'), edit('b.ts'), edit('c.ts')] })).not.toThrow();
  });

  it('accepts a DAG with dependencies', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts'), edit('b.ts', 'edit', ['a.ts']), edit('c.ts', 'edit', ['a.ts', 'b.ts'])],
    };
    expect(() => validateEditPlan(plan)).not.toThrow();
  });

  it('accepts create, edit, delete ops', () => {
    const plan: EditPlan = { edits: [edit('a.ts', 'create'), edit('b.ts', 'edit'), edit('c.ts', 'delete')] };
    expect(() => validateEditPlan(plan)).not.toThrow();
  });
});

describe('validateEditPlan — rejection reasons', () => {
  it('empty-plan — zero edits', () => {
    try {
      validateEditPlan({ edits: [] });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EditPlanValidationError);
      expect((err as EditPlanValidationError).reason).toBe('empty-plan');
    }
  });

  it('invalid-op — unknown op value', () => {
    const plan = { edits: [{ ...edit('a.ts'), op: 'rename' as unknown as 'edit' }] } as EditPlan;
    try {
      validateEditPlan(plan);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('invalid-op');
    }
  });

  it('invalid-path — empty string', () => {
    try {
      validateEditPlan({ edits: [edit('')] });
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('invalid-path');
    }
  });

  it('invalid-path — whitespace only', () => {
    try {
      validateEditPlan({ edits: [edit('   ')] });
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('invalid-path');
    }
  });

  it('incompatible-duplicate — a duplicate path reaching validateEditPlan (caller skipped normalize)', () => {
    try {
      validateEditPlan({ edits: [edit('a.ts'), edit('a.ts', 'delete')] });
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('incompatible-duplicate');
      expect((err as EditPlanValidationError).detail).toMatchObject({ path: 'a.ts' });
    }
  });

  it('unknown-dependsOn — dependency not in the plan', () => {
    try {
      validateEditPlan({ edits: [edit('a.ts', 'edit', ['ghost.ts'])] });
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('unknown-dependsOn');
    }
  });

  it('self-dependency — edit depends on its own path', () => {
    try {
      validateEditPlan({ edits: [edit('a.ts', 'edit', ['a.ts'])] });
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('self-dependency');
    }
  });

  it('cycle — two-node cycle a ↔ b', () => {
    const plan: EditPlan = { edits: [edit('a.ts', 'edit', ['b.ts']), edit('b.ts', 'edit', ['a.ts'])] };
    try {
      validateEditPlan(plan);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('cycle');
      const msg = (err as EditPlanValidationError).message;
      expect(msg).toMatch(/a\.ts|b\.ts/);
    }
  });

  it('cycle — three-node cycle a → b → c → a', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts', 'edit', ['c.ts']), edit('b.ts', 'edit', ['a.ts']), edit('c.ts', 'edit', ['b.ts'])],
    };
    try {
      validateEditPlan(plan);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('cycle');
    }
  });

  it('invalid-dependsOn — dependsOn is not an array', () => {
    const plan = { edits: [{ ...edit('a.ts'), dependsOn: 'b.ts' as unknown as string[] }] } as EditPlan;
    try {
      validateEditPlan(plan);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('invalid-dependsOn');
    }
  });
});

describe('layerPlan — topological layering', () => {
  it('emits one layer for fully independent edits', () => {
    const plan: EditPlan = { edits: [edit('a.ts'), edit('b.ts'), edit('c.ts')] };
    const layers = layerPlan(plan);
    expect(layers).toHaveLength(1);
    expect(layers[0].map((e) => e.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('emits two layers for one dependency edge', () => {
    const plan: EditPlan = { edits: [edit('a.ts'), edit('b.ts', 'edit', ['a.ts'])] };
    const layers = layerPlan(plan);
    expect(layers).toHaveLength(2);
    expect(layers[0].map((e) => e.path)).toEqual(['a.ts']);
    expect(layers[1].map((e) => e.path)).toEqual(['b.ts']);
  });

  it('emits distinct layers honoring the longest path', () => {
    // a → b → c; d is independent of the chain.
    // Layer 0: [a, d], Layer 1: [b], Layer 2: [c]
    const plan: EditPlan = {
      edits: [edit('a.ts'), edit('b.ts', 'edit', ['a.ts']), edit('c.ts', 'edit', ['b.ts']), edit('d.ts')],
    };
    const layers = layerPlan(plan);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((e) => e.path).sort()).toEqual(['a.ts', 'd.ts']);
    expect(layers[1].map((e) => e.path)).toEqual(['b.ts']);
    expect(layers[2].map((e) => e.path)).toEqual(['c.ts']);
  });

  it('collapses diamond dependencies into the correct layer count', () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    // Layers: [a], [b, c], [d]
    const plan: EditPlan = {
      edits: [
        edit('a.ts'),
        edit('b.ts', 'edit', ['a.ts']),
        edit('c.ts', 'edit', ['a.ts']),
        edit('d.ts', 'edit', ['b.ts', 'c.ts']),
      ],
    };
    const layers = layerPlan(plan);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((e) => e.path)).toEqual(['a.ts']);
    expect(layers[1].map((e) => e.path).sort()).toEqual(['b.ts', 'c.ts']);
    expect(layers[2].map((e) => e.path)).toEqual(['d.ts']);
  });

  it('each dependency appears in a strictly-earlier layer than its dependents', () => {
    // Property: for any edge (dep → edit), layer(dep) < layer(edit).
    const plan: EditPlan = {
      edits: [
        edit('root.ts'),
        edit('mid1.ts', 'edit', ['root.ts']),
        edit('mid2.ts', 'edit', ['root.ts']),
        edit('leaf.ts', 'edit', ['mid1.ts', 'mid2.ts']),
      ],
    };
    const layers = layerPlan(plan);
    const layerOf = new Map<string, number>();
    layers.forEach((l, idx) => l.forEach((e) => layerOf.set(e.path, idx)));
    for (const e of plan.edits) {
      for (const dep of e.dependsOn) {
        expect(layerOf.get(dep)!).toBeLessThan(layerOf.get(e.path)!);
      }
    }
  });

  it('preserves all N edits across layers (nothing dropped)', () => {
    const plan: EditPlan = {
      edits: [
        edit('a.ts'),
        edit('b.ts', 'edit', ['a.ts']),
        edit('c.ts', 'edit', ['b.ts']),
        edit('d.ts', 'edit', ['a.ts']),
        edit('e.ts'),
      ],
    };
    const layers = layerPlan(plan);
    const flat = layers
      .flat()
      .map((e) => e.path)
      .sort();
    expect(flat).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });
});

describe('planToLayers — combined normalize + validate + layer', () => {
  it('throws on invalid input before layering', () => {
    expect(() => planToLayers({ edits: [] })).toThrow(EditPlanValidationError);
  });

  it('returns layers for valid input', () => {
    const layers = planToLayers({ edits: [edit('a.ts'), edit('b.ts', 'edit', ['a.ts'])] });
    expect(layers).toHaveLength(2);
  });

  it('merges duplicate edits upstream so a single-layer plan stays single-layer', () => {
    const layers = planToLayers({
      edits: [edit('a.ts', 'edit'), edit('a.ts', 'edit')],
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(1);
    expect(layers[0][0].path).toBe('a.ts');
  });
});

describe('normalizeEditPlan — same-path merges', () => {
  it('merges edit + edit into one edit, joining rationale + unioning dependsOn', () => {
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'first change', dependsOn: ['x.ts'] },
        { path: 'x.ts', op: 'edit', rationale: 'prereq', dependsOn: [] },
        { path: 'a.ts', op: 'edit', rationale: 'second change', dependsOn: ['y.ts', 'x.ts'] },
        { path: 'y.ts', op: 'edit', rationale: 'other prereq', dependsOn: [] },
      ],
    };
    const merged = normalizeEditPlan(plan);
    const a = merged.edits.find((e) => e.path === 'a.ts')!;
    expect(a.op).toBe('edit');
    expect(a.rationale).toBe('first change; second change');
    expect(a.dependsOn).toEqual(['x.ts', 'y.ts']); // first-occurrence order, deduped
  });

  it('merges create + edit into a single create (rationales joined)', () => {
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'create', rationale: 'new module', dependsOn: [] },
        { path: 'a.ts', op: 'edit', rationale: 'extra section', dependsOn: [] },
      ],
    };
    const merged = normalizeEditPlan(plan);
    expect(merged.edits).toHaveLength(1);
    expect(merged.edits[0].op).toBe('create');
    expect(merged.edits[0].rationale).toBe('new module; extra section');
  });

  it('rejects create + create on the same path', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts', 'create'), edit('a.ts', 'create')],
    };
    try {
      normalizeEditPlan(plan);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('incompatible-duplicate');
    }
  });

  it('rejects delete + edit on the same path (ambiguous order)', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts', 'edit'), edit('a.ts', 'delete')],
    };
    expect(() => normalizeEditPlan(plan)).toThrow(EditPlanValidationError);
  });

  it('rejects delete + create on the same path', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts', 'delete'), edit('a.ts', 'create')],
    };
    expect(() => normalizeEditPlan(plan)).toThrow(EditPlanValidationError);
  });

  it('rejects delete + delete on the same path (meaningless)', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts', 'delete'), edit('a.ts', 'delete')],
    };
    expect(() => normalizeEditPlan(plan)).toThrow(EditPlanValidationError);
  });

  it('leaves unique paths untouched', () => {
    const plan: EditPlan = {
      edits: [edit('a.ts'), edit('b.ts', 'create'), edit('c.ts', 'delete')],
    };
    const merged = normalizeEditPlan(plan);
    expect(merged.edits).toHaveLength(3);
  });
});

describe('parseEditPlanJson — defensive parsing of model output', () => {
  it('accepts { edits: [...] } shape', () => {
    const json = JSON.stringify({
      edits: [{ path: 'a.ts', op: 'edit', rationale: 'x', dependsOn: [] }],
    });
    const plan = parseEditPlanJson(json);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].path).toBe('a.ts');
  });

  it('rejects a bare-array top level (object shape only)', () => {
    const json = JSON.stringify([{ path: 'a.ts', op: 'create', rationale: 'new', dependsOn: [] }]);
    try {
      parseEditPlanJson(json);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('invalid-shape');
    }
  });

  it('defaults missing rationale to empty string (not a hard error)', () => {
    const json = JSON.stringify({ edits: [{ path: 'a.ts', op: 'edit', dependsOn: [] }] });
    const plan = parseEditPlanJson(json);
    expect(plan.edits[0].rationale).toBe('');
  });

  it('defaults missing dependsOn to empty array', () => {
    const json = JSON.stringify({ edits: [{ path: 'a.ts', op: 'edit', rationale: 'x' }] });
    const plan = parseEditPlanJson(json);
    expect(plan.edits[0].dependsOn).toEqual([]);
  });

  it('throws EditPlanValidationError on parse failure', () => {
    expect(() => parseEditPlanJson('not json {{{')).toThrow(EditPlanValidationError);
  });

  it('throws on missing path', () => {
    const json = JSON.stringify({ edits: [{ op: 'edit', dependsOn: [] }] });
    expect(() => parseEditPlanJson(json)).toThrow(EditPlanValidationError);
  });

  it('throws on non-string op', () => {
    const json = JSON.stringify({ edits: [{ path: 'a.ts', op: 123, dependsOn: [] }] });
    expect(() => parseEditPlanJson(json)).toThrow(EditPlanValidationError);
  });

  it('throws on non-string dependsOn element', () => {
    const json = JSON.stringify({ edits: [{ path: 'a.ts', op: 'edit', dependsOn: [1, 2] }] });
    expect(() => parseEditPlanJson(json)).toThrow(EditPlanValidationError);
  });

  it('runs validateEditPlan at the end (cycles caught post-parse)', () => {
    const json = JSON.stringify({
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'x', dependsOn: ['b.ts'] },
        { path: 'b.ts', op: 'edit', rationale: 'y', dependsOn: ['a.ts'] },
      ],
    });
    try {
      parseEditPlanJson(json);
      expect.fail('should throw');
    } catch (err) {
      expect((err as EditPlanValidationError).reason).toBe('cycle');
    }
  });

  it('rejects invalid top-level shape (neither array nor object-with-edits)', () => {
    expect(() => parseEditPlanJson(JSON.stringify({ foo: 'bar' }))).toThrow(EditPlanValidationError);
  });
});
