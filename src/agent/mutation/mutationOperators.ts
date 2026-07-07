// ---------------------------------------------------------------------------
// Mutation operators — verify-the-verifier (scaffolding roadmap #3).
//
// A test suite (or a completion gate that trusts one) is only as credible as
// the bugs it can CATCH. Mutation testing measures exactly that: seed a small
// fault into the code — flip `<` to `>=`, `+` to `-`, `and` to `or` — and see
// whether the test still passes. A surviving mutant is a bug the tests would
// miss; the mutation score (killed / viable) is the credibility number the
// behavioral-verification gate has never had.
//
// This module is the pure generator: given source, produce single-point mutants
// (each flips exactly ONE operator occurrence, everything else untouched). The
// runner writes each mutant + runs the test; the scorer aggregates.
//
// Robustness: operator matches are found on a MASKED copy where the contents of
// strings and comments are blanked, so we never mutate a `<` inside `"a<b"` or a
// `#` comment. Splices land in the ORIGINAL source at the masked positions.
// Language-agnostic by construction, tuned for Python/JS/TS (SWE-bench is
// Python) — conservative where a token is ambiguous (generics, unary), because a
// missed mutant only lowers the count, while a bad mutant produces noise.
// ---------------------------------------------------------------------------

export interface Mutant {
  /** Stable id: `<operator>#<ordinal>`. */
  id: string;
  operator: 'relational' | 'arithmetic' | 'logical' | 'boolean-literal';
  /** 1-based line of the mutated token. */
  line: number;
  /** The token replaced (e.g. `<`). */
  original: string;
  /** What it became (e.g. `>=`). */
  replacement: string;
  description: string;
  /** Full source with exactly this one mutation applied. */
  mutatedSource: string;
}

/** Blank the CONTENT of strings and comments (preserving length + newlines) so
 *  operator scans never match inside a literal or comment. Handles line
 *  comments (`#`, `//`), block comments (`/* *​/`), single/double/backtick
 *  strings, and Python triple-quoted strings. */
export function maskStringsAndComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (i: number): void => {
    if (src[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (c === '#' || c2 === '//') {
      while (i < n && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c2 === '/*') {
      blank(i++);
      blank(i++);
      while (i < n && src.slice(i, i + 2) !== '*/') blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const triple = src.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        i += 3; // keep the delimiter chars (not operators)
        while (i < n && src.slice(i, i + 3) !== triple) blank(i++);
        i += 3;
        continue;
      }
      const q = c;
      i++; // keep opening quote
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        blank(i++);
      }
      i++; // consume closing quote
      continue;
    }
    i++;
  }
  return out.join('');
}

interface Hit {
  index: number;
  length: number;
  original: string;
  replacement: string;
}

/** Line number (1-based) of a character offset. */
function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// Each operator scans the masked source and yields hits (position + swap).

function relationalHits(masked: string): Hit[] {
  // Match longest operators first so `<=` isn't split into `<`. Guard against
  // arrows/shifts: `=>`, `->`, `<<`, `>>`, and `===`/`!==` (3-char) handled
  // explicitly. Chained `==`/`!=` excluded from single `<`/`>`.
  const swaps: Array<[RegExp, string]> = [
    [/(?<![=!<>])===(?!=)/g, '!=='],
    [/(?<![=!<>])!==(?!=)/g, '==='],
    [/(?<![=!<>])==(?![=])/g, '!='],
    [/(?<![=!<>])!=(?![=])/g, '=='],
    [/<=/g, '>'],
    [/>=/g, '<'],
    [/(?<![<=])<(?![<=])/g, '>='],
    [/(?<![>=])>(?![>=])/g, '<='],
  ];
  const hits: Hit[] = [];
  const taken = new Set<number>();
  for (const [re, replacement] of swaps) {
    for (const m of masked.matchAll(re)) {
      const idx = m.index;
      if (idx === undefined || taken.has(idx)) continue;
      // Skip `=>` arrows caught by the `>` rule.
      if (replacement === '<=' && masked[idx - 1] === '=') continue;
      for (let k = 0; k < m[0].length; k++) taken.add(idx + k);
      hits.push({ index: idx, length: m[0].length, original: m[0], replacement });
    }
  }
  return hits;
}

function arithmeticHits(masked: string): Hit[] {
  // Conservative: only spaced binary operators (` + `, ` - `, ` * `, ` / `) so
  // we skip `++`, `+=`, unary minus, `*args`/`**kwargs`, `//` and `/*`.
  const map: Record<string, string> = { '+': '-', '-': '+', '*': '/', '/': '*' };
  const hits: Hit[] = [];
  for (const m of masked.matchAll(/ ([+\-*/]) /g)) {
    if (m.index === undefined) continue;
    const op = m[1];
    hits.push({ index: m.index + 1, length: 1, original: op, replacement: map[op] });
  }
  return hits;
}

function logicalHits(masked: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of masked.matchAll(/&&|\|\|/g)) {
    if (m.index === undefined) continue;
    hits.push({ index: m.index, length: 2, original: m[0], replacement: m[0] === '&&' ? '||' : '&&' });
  }
  for (const m of masked.matchAll(/\b(and|or)\b/g)) {
    if (m.index === undefined) continue;
    hits.push({ index: m.index, length: m[0].length, original: m[0], replacement: m[0] === 'and' ? 'or' : 'and' });
  }
  return hits;
}

function booleanLiteralHits(masked: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of masked.matchAll(/\b(True|False|true|false)\b/g)) {
    if (m.index === undefined) continue;
    const map: Record<string, string> = { True: 'False', False: 'True', true: 'false', false: 'true' };
    hits.push({ index: m.index, length: m[0].length, original: m[0], replacement: map[m[0]] });
  }
  return hits;
}

const OPERATORS: Array<{ name: Mutant['operator']; find: (masked: string) => Hit[] }> = [
  { name: 'relational', find: relationalHits },
  { name: 'arithmetic', find: arithmeticHits },
  { name: 'logical', find: logicalHits },
  { name: 'boolean-literal', find: booleanLiteralHits },
];

export interface GenerateOptions {
  /** Cap the number of mutants produced (deterministic prefix). Default 200. */
  maxMutants?: number;
  /** Restrict to these operator categories. Default: all. */
  operators?: Mutant['operator'][];
}

/**
 * Generate single-point mutants for a source file. Deterministic order:
 * operator category, then position. Each mutant flips exactly one occurrence.
 */
export function generateMutants(source: string, options: GenerateOptions = {}): Mutant[] {
  const masked = maskStringsAndComments(source);
  const enabled = options.operators;
  const cap = options.maxMutants ?? 200;
  const mutants: Mutant[] = [];
  for (const op of OPERATORS) {
    if (enabled && !enabled.includes(op.name)) continue;
    const hits = op.find(masked).sort((a, b) => a.index - b.index);
    let ordinal = 0;
    for (const h of hits) {
      ordinal++;
      const mutatedSource = source.slice(0, h.index) + h.replacement + source.slice(h.index + h.length);
      mutants.push({
        id: `${op.name}#${ordinal}`,
        operator: op.name,
        line: lineAt(source, h.index),
        original: h.original,
        replacement: h.replacement,
        description: `${op.name}: \`${h.original}\` → \`${h.replacement}\` at line ${lineAt(source, h.index)}`,
        mutatedSource,
      });
      if (mutants.length >= cap) return mutants;
    }
  }
  return mutants;
}
