import { describe, it, expect } from 'vitest';
import { buildFacetRegistry, buildDefaultFacetRegistry, mergeWithBuiltInFacets } from './facetRegistry.js';
import { builtInFacets, FacetValidationError, type FacetDefinition } from './facetLoader.js';

// ---------------------------------------------------------------------------
// Tests for facetRegistry.ts (v0.66 chunk 3.2).
//
// The registry layer runs the cross-facet invariants the loader can't
// see (only the loader knows about one file at a time). Coverage:
//   - duplicate-id rejection
//   - unknown-dependsOn rejection
//   - cycle detection (2-node, 3-node, deep chain)
//   - topological layers match dependency order
//   - builtins merge with overrides (override wins)
// ---------------------------------------------------------------------------

function facet(overrides: Partial<FacetDefinition> = {}): FacetDefinition {
  return {
    id: 'f',
    displayName: 'F',
    systemPrompt: 'test',
    source: 'project',
    filePath: '/x/f.md',
    dependsOn: [],
    ...overrides,
  } as FacetDefinition;
}

describe('buildFacetRegistry — happy paths', () => {
  it('builds a registry with the built-in catalog', () => {
    const reg = buildDefaultFacetRegistry();
    expect(reg.all.length).toBeGreaterThan(0);
    expect(reg.get('general-coder')).toBeDefined();
    expect(reg.has('general-coder')).toBe(true);
    expect(reg.has('nonexistent')).toBe(false);
  });

  it('preserves input order in `all`', () => {
    const facets = [facet({ id: 'a' }), facet({ id: 'b' }), facet({ id: 'c' })];
    const reg = buildFacetRegistry(facets);
    expect(reg.all.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildFacetRegistry — duplicate-id rejection', () => {
  it('throws FacetValidationError with reason "duplicate-id"', () => {
    const facets = [facet({ id: 'a', filePath: '/one.md' }), facet({ id: 'a', filePath: '/two.md' })];
    try {
      buildFacetRegistry(facets);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FacetValidationError);
      expect((err as FacetValidationError).reason).toBe('duplicate-id');
    }
  });

  it('names both paths in the error message so authors can find the conflict', () => {
    const facets = [facet({ id: 'a', filePath: '/one.md' }), facet({ id: 'a', filePath: '/two.md' })];
    try {
      buildFacetRegistry(facets);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).message).toContain('/one.md');
      expect((err as FacetValidationError).message).toContain('/two.md');
    }
  });
});

describe('buildFacetRegistry — unknown-dependency rejection', () => {
  it('throws when a facet depends on a nonexistent id', () => {
    const facets = [facet({ id: 'a', dependsOn: ['ghost'] })];
    expect(() => buildFacetRegistry(facets)).toThrow(/depends on "ghost"/);
  });
});

describe('buildFacetRegistry — cycle detection', () => {
  it('detects a two-node cycle a → b → a', () => {
    const facets = [facet({ id: 'a', dependsOn: ['b'] }), facet({ id: 'b', dependsOn: ['a'] })];
    try {
      buildFacetRegistry(facets);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('cycle');
      expect((err as FacetValidationError).message).toMatch(/a.*→.*b|b.*→.*a/);
    }
  });

  it('detects a three-node cycle a → b → c → a', () => {
    const facets = [
      facet({ id: 'a', dependsOn: ['c'] }),
      facet({ id: 'b', dependsOn: ['a'] }),
      facet({ id: 'c', dependsOn: ['b'] }),
    ];
    expect(() => buildFacetRegistry(facets)).toThrow(/cycle/i);
  });

  it('accepts a linear chain (no cycle)', () => {
    const facets = [
      facet({ id: 'a', dependsOn: [] }),
      facet({ id: 'b', dependsOn: ['a'] }),
      facet({ id: 'c', dependsOn: ['b'] }),
    ];
    expect(() => buildFacetRegistry(facets)).not.toThrow();
  });

  it('accepts a diamond (a → b, a → c, b + c → d)', () => {
    const facets = [
      facet({ id: 'a' }),
      facet({ id: 'b', dependsOn: ['a'] }),
      facet({ id: 'c', dependsOn: ['a'] }),
      facet({ id: 'd', dependsOn: ['b', 'c'] }),
    ];
    expect(() => buildFacetRegistry(facets)).not.toThrow();
  });
});

describe('buildFacetRegistry — topological layers', () => {
  it('puts fully-independent facets in one layer', () => {
    const facets = [facet({ id: 'a' }), facet({ id: 'b' }), facet({ id: 'c' })];
    const reg = buildFacetRegistry(facets);
    const layers = reg.layers();
    expect(layers).toHaveLength(1);
    expect(layers[0].map((f) => f.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('respects dependency chain in layer ordering', () => {
    const facets = [facet({ id: 'a' }), facet({ id: 'b', dependsOn: ['a'] }), facet({ id: 'c', dependsOn: ['b'] })];
    const reg = buildFacetRegistry(facets);
    const layers = reg.layers();
    expect(layers).toHaveLength(3);
    expect(layers[0][0].id).toBe('a');
    expect(layers[1][0].id).toBe('b');
    expect(layers[2][0].id).toBe('c');
  });

  it('groups diamond midpoints into the same layer', () => {
    const facets = [
      facet({ id: 'a' }),
      facet({ id: 'b', dependsOn: ['a'] }),
      facet({ id: 'c', dependsOn: ['a'] }),
      facet({ id: 'd', dependsOn: ['b', 'c'] }),
    ];
    const reg = buildFacetRegistry(facets);
    const layers = reg.layers();
    expect(layers).toHaveLength(3);
    expect(layers[0].map((f) => f.id)).toEqual(['a']);
    expect(layers[1].map((f) => f.id).sort()).toEqual(['b', 'c']);
    expect(layers[2].map((f) => f.id)).toEqual(['d']);
  });
});

describe('mergeWithBuiltInFacets', () => {
  it('returns the full built-in catalog when overrides is empty', () => {
    const merged = mergeWithBuiltInFacets([]);
    expect(merged.length).toBe(builtInFacets().length);
    expect(merged.find((f) => f.id === 'general-coder')).toBeDefined();
  });

  it('a disk-loaded facet with the same id as a builtin replaces the builtin', () => {
    const override = facet({
      id: 'general-coder',
      displayName: 'Overridden Coder',
      filePath: '/proj/.sidecar/facets/general-coder.md',
    });
    const merged = mergeWithBuiltInFacets([override]);
    const gc = merged.find((f) => f.id === 'general-coder');
    expect(gc!.displayName).toBe('Overridden Coder');
    expect(gc!.filePath).toBe('/proj/.sidecar/facets/general-coder.md');
  });

  it('adds a new facet that does not conflict with any builtin', () => {
    const novel = facet({ id: 'custom-specialist', filePath: '/proj/.sidecar/facets/custom.md' });
    const merged = mergeWithBuiltInFacets([novel]);
    expect(merged.find((f) => f.id === 'custom-specialist')).toBeDefined();
    // Builtins still present.
    expect(merged.find((f) => f.id === 'general-coder')).toBeDefined();
  });

  it('rejects two overrides sharing the same id', () => {
    const a = facet({ id: 'dup', filePath: '/a.md' });
    const b = facet({ id: 'dup', filePath: '/b.md' });
    expect(() => mergeWithBuiltInFacets([a, b])).toThrow(FacetValidationError);
  });
});
