import { describe, it, expect } from 'vitest';
import { parseFacetFile, builtInFacets, indexFacets, facetSlugFromPath, FacetValidationError } from './facetLoader.js';

// ---------------------------------------------------------------------------
// Tests for facetLoader.ts (v0.66 chunk 3.1).
//
// parseFacetFile is the per-file structural check. The registry (3.2)
// handles cross-facet invariants (duplicate id, cycles). These tests
// focus on the shape each frontmatter field lands in, the rejection
// reasons, and the built-in catalog's baseline health.
// ---------------------------------------------------------------------------

function makeFacet(frontmatter: string, body = 'You are a test specialist.'): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

describe('parseFacetFile — happy paths', () => {
  it('parses minimal scalar fields', () => {
    const raw = makeFacet('id: my-facet\ndisplayName: My Facet');
    const facet = parseFacetFile('/x/my-facet.md', raw, 'project');
    expect(facet.id).toBe('my-facet');
    expect(facet.displayName).toBe('My Facet');
    expect(facet.systemPrompt).toBe('You are a test specialist.');
    expect(facet.source).toBe('project');
    expect(facet.filePath).toBe('/x/my-facet.md');
  });

  it('parses JSON-array fields (toolAllowlist, skillBundle, dependsOn)', () => {
    const raw = makeFacet(
      `id: a
displayName: A
toolAllowlist: ["read_file", "grep"]
skillBundle: ["signal-processing"]
dependsOn: []`,
    );
    const facet = parseFacetFile('/x/a.md', raw, 'project');
    expect(facet.toolAllowlist).toEqual(['read_file', 'grep']);
    expect(facet.skillBundle).toEqual(['signal-processing']);
    expect(facet.dependsOn).toEqual([]);
  });

  it('parses rpcSchema as a JSON object mapping methods to shapes', () => {
    const raw = makeFacet(
      `id: dsp
displayName: DSP
rpcSchema: {"publishMathBlock": {"params": {"symbol": "string", "latex": "string"}}, "requestDefinition": {}}`,
    );
    const facet = parseFacetFile('/x/dsp.md', raw, 'project');
    expect(facet.rpcSchema).toBeDefined();
    expect(Object.keys(facet.rpcSchema!)).toEqual(['publishMathBlock', 'requestDefinition']);
    expect(facet.rpcSchema!.publishMathBlock.params).toEqual({ symbol: 'string', latex: 'string' });
  });

  it('trims quoted scalar values (JSON-ish scalars work too)', () => {
    const raw = makeFacet(`id: a\ndisplayName: "Quoted Name"\npreferredModel: 'claude-haiku-4-5'`);
    const facet = parseFacetFile('/x/a.md', raw, 'user');
    expect(facet.displayName).toBe('Quoted Name');
    expect(facet.preferredModel).toBe('claude-haiku-4-5');
  });

  it('treats empty preferredModel as undefined (lets router / default take over)', () => {
    const raw = makeFacet(`id: a\ndisplayName: A\npreferredModel: `);
    const facet = parseFacetFile('/x/a.md', raw, 'project');
    expect(facet.preferredModel).toBeUndefined();
  });

  it('ignores comment lines and blank lines in frontmatter', () => {
    const raw = makeFacet(`# top comment
id: a
displayName: A

# inline comment
toolAllowlist: []`);
    const facet = parseFacetFile('/x/a.md', raw, 'project');
    expect(facet.id).toBe('a');
    expect(facet.toolAllowlist).toEqual([]);
  });
});

describe('parseFacetFile — rejection reasons', () => {
  it('missing-frontmatter when the file has no `---` block', () => {
    try {
      parseFacetFile('/x/a.md', 'just a body\n', 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FacetValidationError);
      expect((err as FacetValidationError).reason).toBe('missing-frontmatter');
    }
  });

  it('empty-system-prompt when the post-frontmatter body is empty', () => {
    try {
      parseFacetFile('/x/a.md', '---\nid: a\ndisplayName: A\n---\n\n\n', 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('empty-system-prompt');
    }
  });

  it('missing-id when the frontmatter has no id field', () => {
    const raw = makeFacet('displayName: A');
    expect(() => parseFacetFile('/x/a.md', raw, 'project')).toThrow(/missing required `id`/);
  });

  it('invalid-id for values with uppercase or spaces', () => {
    for (const bad of ['My-Facet', 'spaces here', '-leadingdash', '.dot']) {
      try {
        parseFacetFile('/x/a.md', makeFacet(`id: ${bad}\ndisplayName: A`), 'project');
        expect.fail(`expected throw for id="${bad}"`);
      } catch (err) {
        expect((err as FacetValidationError).reason).toBe('invalid-id');
      }
    }
  });

  it('missing-display-name when displayName is absent or blank', () => {
    try {
      parseFacetFile('/x/a.md', makeFacet('id: a'), 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('missing-display-name');
    }
  });

  it('invalid-json when toolAllowlist is unparseable JSON', () => {
    const raw = makeFacet(`id: a\ndisplayName: A\ntoolAllowlist: [unclosed`);
    try {
      parseFacetFile('/x/a.md', raw, 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('invalid-json');
    }
  });

  it('invalid-field-shape when toolAllowlist is not an array', () => {
    const raw = makeFacet(`id: a\ndisplayName: A\ntoolAllowlist: {"not": "array"}`);
    try {
      parseFacetFile('/x/a.md', raw, 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('invalid-field-shape');
    }
  });

  it('invalid-field-shape when toolAllowlist contains non-strings', () => {
    const raw = makeFacet(`id: a\ndisplayName: A\ntoolAllowlist: ["read_file", 123]`);
    expect(() => parseFacetFile('/x/a.md', raw, 'project')).toThrow(FacetValidationError);
  });

  it('invalid-field-shape when rpcSchema is not an object', () => {
    const raw = makeFacet(`id: a\ndisplayName: A\nrpcSchema: ["not", "object"]`);
    try {
      parseFacetFile('/x/a.md', raw, 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('invalid-field-shape');
    }
  });

  it("self-dependency when dependsOn includes the facet's own id", () => {
    const raw = makeFacet(`id: loop\ndisplayName: L\ndependsOn: ["loop"]`);
    try {
      parseFacetFile('/x/loop.md', raw, 'project');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as FacetValidationError).reason).toBe('self-dependency');
    }
  });
});

describe('builtInFacets — shape + baseline health', () => {
  it('ships a non-empty catalog of facets', () => {
    const facets = builtInFacets();
    expect(facets.length).toBeGreaterThan(0);
  });

  it('every built-in has a valid id, displayName, and systemPrompt', () => {
    for (const f of builtInFacets()) {
      expect(f.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      expect(f.displayName.length).toBeGreaterThan(0);
      expect(f.systemPrompt.length).toBeGreaterThan(0);
      expect(f.source).toBe('builtin');
      expect(f.filePath).toBe('');
    }
  });

  it('every built-in has unique ids', () => {
    const facets = builtInFacets();
    const ids = facets.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('built-in security-reviewer does not allow write_file or edit_file (matches spec)', () => {
    const sr = builtInFacets().find((f) => f.id === 'security-reviewer');
    expect(sr).toBeDefined();
    expect(sr!.toolAllowlist).not.toContain('write_file');
    expect(sr!.toolAllowlist).not.toContain('edit_file');
    expect(sr!.toolAllowlist).not.toContain('run_command');
  });

  it('built-in latex-writer does not allow run_command (doc tools only)', () => {
    const lx = builtInFacets().find((f) => f.id === 'latex-writer');
    expect(lx!.toolAllowlist).not.toContain('run_command');
  });
});

describe('indexFacets', () => {
  it('returns a map keyed by id', () => {
    const map = indexFacets(builtInFacets());
    expect(map.get('general-coder')).toBeDefined();
    expect(map.get('nonexistent')).toBeUndefined();
  });
});

describe('facetSlugFromPath', () => {
  it('strips directory + .md extension', () => {
    expect(facetSlugFromPath('/workspace/.sidecar/facets/frontend.md')).toBe('frontend');
    expect(facetSlugFromPath('frontend.md')).toBe('frontend');
  });
});
