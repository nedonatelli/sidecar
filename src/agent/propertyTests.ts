/**
 * Property-based test synthesis (the §5 vertical — pillar 3, "prove the math").
 *
 * Analytic bounds (`analyticBounds.ts`) check a result against a value range.
 * Property tests are the generalization: a KERNEL declares an invariant that
 * must hold for ALL inputs — symmetric `f(a,b) == f(b,a)`, idempotent
 * `f(f(x)) == f(x)`, conservation `sum(f(x)) == sum(x)`, or a value bound — and
 * we synthesize a Hypothesis test that generates random inputs and tries to
 * violate it. A bound is just one property kind, so this reuses the bound
 * parser + assertion emitter directly.
 *
 * The synthesized test is COMPLETE and runnable (imports, `@given` strategies,
 * assertions) — never a stub. Default strategies are numpy float arrays via
 * `hypothesis.extra.numpy`, which fit the numerical-kernel target; the agent can
 * tighten them, but the emitted test runs as-is.
 *
 * Pure string generation, no VS Code / fs — the tool layer supplies the file
 * and signature.
 */

import { parseBoundDeclarations, boundAssertion, type BoundDeclaration } from './analyticBounds.js';

export type PropertyKind = 'bound' | 'symmetric' | 'idempotent' | 'monotonic' | 'nonneg' | 'conservation' | 'custom';

export interface PropertyDecl {
  kind: PropertyKind;
  /** Raw declaration text (for the assertion + comment). */
  raw: string;
  line: number;
  /** Present when kind === 'bound' (the parsed bound). */
  bound?: BoundDeclaration;
}

const NAMED: ReadonlyArray<{ re: RegExp; kind: PropertyKind }> = [
  { re: /\b(symmetric|commutative)\b/i, kind: 'symmetric' },
  { re: /\bidempotent\b/i, kind: 'idempotent' },
  { re: /\bmonotonic(?:ally)?\b/i, kind: 'monotonic' },
  { re: /\bnon-?negative\b/i, kind: 'nonneg' },
];

/** Parse property declarations (`# property: …`) plus bounds/invariants (reused
 *  from analyticBounds) out of a kernel's source slice. */
export function parsePropertyDeclarations(source: string): PropertyDecl[] {
  const out: PropertyDecl[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*#\s*(?:property|invariant-of|prop)\s*:\s*(.+?)\s*$/i);
    if (!m || !m[1]?.trim()) continue;
    const raw = m[1].trim();
    const named = NAMED.find((n) => n.re.test(raw));
    out.push({ kind: named ? named.kind : 'custom', raw, line: i + 1 });
  }
  // Bounds and invariants are properties too.
  for (const b of parseBoundDeclarations(source)) {
    out.push({
      kind: b.kind === 'conservation' ? 'conservation' : 'bound',
      raw: b.raw,
      line: b.line,
      bound: b,
    });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/** Parameter names from a `def name(a, b, *args, kw=1):` line — positional,
 *  non-self, non-variadic, non-keyword-only defaults stripped. */
export function parseParams(source: string, func: string): string[] {
  const re = new RegExp(String.raw`def\s+${func}\s*\(([^)]*)\)`);
  const m = source.match(re);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((p) => p.trim().split(/[:=]/)[0].trim())
    .filter((p) => p && p !== 'self' && p !== 'cls' && !p.startsWith('*'));
}

const ARRAY_STRATEGY =
  'arrays(np.float64, array_shapes(min_dims=1, max_dims=1, min_side=1, max_side=8), ' +
  'elements=st.floats(-1e3, 1e3, allow_nan=False, allow_infinity=False))';

/** Emit the assertion body lines for one property. `p0`, `p1`, … are the param
 *  names; `result` is `func(*params)`. */
function assertionsFor(prop: PropertyDecl, func: string, params: string[]): string[] {
  const call = (args: string[]): string => `${func}(${args.join(', ')})`;
  switch (prop.kind) {
    case 'bound':
      return [`    # bound: ${prop.raw}`, `    ${boundAssertion(prop.bound!)}`];
    case 'nonneg':
      return [`    # property: non-negative`, `    assert np.all(result >= 0), "result must be non-negative"`];
    case 'conservation':
      return [`    # invariant: ${prop.raw}`, `    assert ${prop.raw}, "conservation violated"`];
    case 'symmetric':
      if (params.length < 2) return [`    # property: symmetric — needs >=2 params, skipped`];
      return [
        `    # property: symmetric — ${call([params[0], params[1]])} == ${call([params[1], params[0]])}`,
        `    assert np.allclose(result, ${call([params[1], params[0], ...params.slice(2)])}), "not symmetric"`,
      ];
    case 'idempotent':
      return [
        `    # property: idempotent — f(f(x)) == f(x)`,
        `    assert np.allclose(result, ${call(['result', ...params.slice(1)])}), "not idempotent"`,
      ];
    case 'monotonic':
      return [
        `    # property: monotonic (spot check on a sorted variant)`,
        `    _mono = ${call([`np.sort(${params[0]})`, ...params.slice(1)])}`,
        `    assert np.all(np.diff(_mono) >= -1e-9), "not monotonic non-decreasing"`,
      ];
    case 'custom':
      return [
        `    # property: ${prop.raw}`,
        `    assert ${prop.raw}, "property violated: ${prop.raw.replace(/"/g, "'")}"`,
      ];
  }
}

export interface SynthesizeOptions {
  /** Module import path (dotted), e.g. `src.geometry`. Omit to leave a TODO-free
   *  relative import the agent can adjust. */
  module?: string;
  maxExamples?: number;
}

/**
 * Synthesize a complete Hypothesis property test for `func` from the properties
 * declared in `source`. Returns null when the kernel declares no properties
 * (nothing to test). Default array strategies target numerical kernels.
 */
export function synthesizeHypothesisTest(func: string, source: string, opts: SynthesizeOptions = {}): string | null {
  const props = parsePropertyDeclarations(source);
  if (props.length === 0) return null;
  const params = parseParams(source, func);
  const strategyParams = params.length > 0 ? params : ['x'];
  const maxExamples = opts.maxExamples ?? 100;
  const importLine = opts.module ? `from ${opts.module} import ${func}` : `from module_under_test import ${func}`;

  const givenArgs = strategyParams.map(() => ARRAY_STRATEGY).join(',\n    ');
  const body: string[] = [];
  for (const p of props) body.push(...assertionsFor(p, func, strategyParams));

  return [
    'import numpy as np',
    'from hypothesis import given, settings',
    'from hypothesis.extra.numpy import arrays, array_shapes',
    'import hypothesis.strategies as st',
    importLine,
    '',
    '',
    `@settings(max_examples=${maxExamples})`,
    `@given(`,
    `    ${givenArgs},`,
    `)`,
    `def test_${func}_properties(${strategyParams.join(', ')}):`,
    `    result = ${func}(${strategyParams.join(', ')})`,
    ...body,
    '',
  ].join('\n');
}
