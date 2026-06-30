/**
 * Shape-contract propagation (§5, rungs A + B) over the code graph.
 *
 * Rung A — intra-kernel consistency: within one function, a parameter's shape
 * annotation and a `assert p.shape == …` on that same parameter must agree.
 * Rung B — tail-call return matching: `def f(...): return g(...)` means f and g
 * return the same array, so their declared return shapes must agree.
 *
 * Operates on Python signatures (the numerical surface). Symbolic dims are
 * wildcards (see shapeSpec), so only provable conflicts surface.
 */

import type { SymbolGraph, SymbolEntry } from '../config/symbolGraph.js';
import { parseTypeShape, parseShapeTuple, shapeConflict, type ShapeSpec, type ShapeConflict } from './shapeSpec.js';

export interface ShapeIssue {
  kernel: string;
  file: string;
  line: number; // 1-based
  kind: 'intra-kernel' | 'tail-call' | 'dataflow';
  conflict: ShapeConflict;
  detail: string;
}

export type SourceReader = (file: string) => string | undefined;

interface CallSite {
  callee: string;
  args: Array<string | null>; // positional bare-identifier names; null = non-identifier
  hasKwargs: boolean;
}

interface KernelShapes {
  params: Map<string, ShapeSpec>; // shaped params only (Rung A/B)
  paramOrder: Array<{ name: string; spec: ShapeSpec | null }>; // all params, positional (Rung C)
  hasVarargs: boolean; // *args/**kwargs present → positional matching unsafe
  returnSpec: ShapeSpec | null;
  assertShapes: Map<string, ShapeSpec>; // var name → asserted shape/dtype
  tailReturnCallees: string[]; // `return g(...)` callee names
  /** Single-assignment `var = callee(...)` → callee name. A var assigned more
   *  than once (or from a non-call) maps to null and is not trusted. */
  callAssignments: Map<string, string | null>;
  callSites: CallSite[];
}

/** Index of the `)` matching the `(` at `open`. Returns -1 if unbalanced. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas (ignoring nested brackets and quotes). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '[' || c === '(' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ']' || c === ')' || c === '}') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Extract the return annotation between `->` and the top-level `:` that ends a
 *  Python signature. */
function returnAnnotation(afterParen: string): string | null {
  const arrow = afterParen.indexOf('->');
  if (arrow < 0) return null;
  let depth = 0;
  for (let i = arrow + 2; i < afterParen.length; i++) {
    const c = afterParen[i];
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if (c === ':' && depth === 0) return afterParen.slice(arrow + 2, i).trim();
  }
  return null;
}

/** Parse a function's source slice into the shape statements it makes. */
export function extractKernelShapes(source: string): KernelShapes {
  const params = new Map<string, ShapeSpec>();
  const paramOrder: Array<{ name: string; spec: ShapeSpec | null }> = [];
  const assertShapes = new Map<string, ShapeSpec>();
  const tailReturnCallees: string[] = [];
  let returnSpec: ShapeSpec | null = null;
  let hasVarargs = false;

  const defMatch = source.match(/\bdef\s+\w+\s*\(/);
  if (defMatch) {
    const open = defMatch.index! + defMatch[0].length - 1;
    const close = matchingParen(source, open);
    if (close > open) {
      for (const raw of splitTopLevel(source.slice(open + 1, close))) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('*')) {
          hasVarargs = true;
          continue;
        }
        const colon = topLevelColon(raw);
        const name = (colon < 0 ? trimmed : raw.slice(0, colon).trim()).replace(/\s*=.*$/, '');
        let spec: ShapeSpec | null = null;
        if (colon >= 0) {
          let anno = raw.slice(colon + 1);
          const eq = topLevelEquals(anno);
          if (eq >= 0) anno = anno.slice(0, eq);
          spec = parseTypeShape(anno.trim());
        }
        if (name) {
          paramOrder.push({ name, spec });
          if (spec) params.set(name, spec);
        }
      }
      const ret = returnAnnotation(source.slice(close + 1));
      if (ret) returnSpec = parseTypeShape(ret);
    }
  }

  // assert x.shape == (…)
  const shapeAssert = /\bassert\s+(\w+)\.shape\s*==\s*(\([^)]*\))/g;
  let m: RegExpExecArray | null;
  while ((m = shapeAssert.exec(source)) !== null) {
    const spec = parseShapeTuple(m[2]);
    if (spec) assertShapes.set(m[1], spec);
  }
  // assert x.dtype == np.float64
  const dtypeAssert = /\bassert\s+(\w+)\.dtype\s*==\s*([\w.]+)/g;
  while ((m = dtypeAssert.exec(source)) !== null) {
    const existing = assertShapes.get(m[1]);
    if (existing) existing.dtype = m[2];
    else assertShapes.set(m[1], { dims: null, dtype: m[2] });
  }
  // return g(...)
  const tailReturn = /\breturn\s+(\w+)\s*\(/g;
  while ((m = tailReturn.exec(source)) !== null) tailReturnCallees.push(m[1]);

  return {
    params,
    paramOrder,
    hasVarargs,
    returnSpec,
    assertShapes,
    tailReturnCallees,
    callAssignments: extractCallAssignments(source),
    callSites: extractCallSites(source),
  };
}

/**
 * `var = callee(...)` single assignments → callee name. A var assigned more than
 * once, or whose RHS is not a direct call, maps to null (untrusted) so dataflow
 * can't follow an ambiguous binding.
 */
function extractCallAssignments(source: string): Map<string, string | null> {
  const rhsByVar = new Map<string, string[]>();
  for (const line of source.split('\n')) {
    // LHS = RHS, optional annotation; exclude ==, <=, >=, !=.
    const m = line.match(/^\s*(\w+)\s*(?::\s*[^=\n]+?)?=(?!=)\s*(.*)$/);
    if (!m) continue;
    const list = rhsByVar.get(m[1]);
    if (list) list.push(m[2].trim());
    else rhsByVar.set(m[1], [m[2].trim()]);
  }
  const out = new Map<string, string | null>();
  for (const [v, rhsList] of rhsByVar) {
    if (rhsList.length !== 1) {
      out.set(v, null); // reassigned → ambiguous
      continue;
    }
    const call = rhsList[0].match(/^(\w+)\s*\(/);
    out.set(v, call ? call[1] : null);
  }
  return out;
}

/** Function calls with no nested parens in their argument list: callee name +
 *  positional args (bare identifiers, else null) + a keyword-arg flag. */
function extractCallSites(source: string): CallSite[] {
  const sites: CallSite[] = [];
  const callRe = /(\w+)\s*\(([^()]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    // Skip the `def name(...)` declaration itself.
    if (/\bdef\s+$/.test(source.slice(Math.max(0, m.index - 5), m.index))) continue;
    const argParts = m[2].trim() ? splitTopLevel(m[2]) : [];
    let hasKwargs = false;
    const args = argParts.map((a) => {
      const t = a.trim();
      if (topLevelIndexOf(t, '=') >= 0 && !t.includes('==')) hasKwargs = true;
      return /^[A-Za-z_]\w*$/.test(t) ? t : null;
    });
    sites.push({ callee: m[1], args, hasKwargs });
  }
  return sites;
}

function topLevelColon(s: string): number {
  return topLevelIndexOf(s, ':');
}
function topLevelEquals(s: string): number {
  return topLevelIndexOf(s, '=');
}
function topLevelIndexOf(s: string, ch: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function sliceSource(content: string, sym: SymbolEntry): string {
  const lines = content.split('\n');
  return lines.slice(Math.max(0, sym.startLine), sym.endLine + 1).join('\n');
}

/**
 * Run both propagation rungs over the functions in scope. `fileFilter` bounds
 * which files' functions are checked (Rung A); tail-call resolution (Rung B)
 * may reach callees in any file.
 */
export function checkShapeConsistency(
  graph: SymbolGraph,
  readSource: SourceReader,
  opts?: { fileFilter?: (file: string) => boolean },
): ShapeIssue[] {
  const issues: ShapeIssue[] = [];
  const sourceCache = new Map<string, string | undefined>();
  const read = (f: string): string | undefined => {
    if (!sourceCache.has(f)) sourceCache.set(f, readSource(f));
    return sourceCache.get(f);
  };
  const shapesCache = new Map<string, KernelShapes>(); // file::name → shapes
  const shapesOf = (file: string, sym: SymbolEntry): KernelShapes | null => {
    const key = `${file}::${sym.name}`;
    const cached = shapesCache.get(key);
    if (cached) return cached;
    const content = read(file);
    if (!content) return null;
    const ks = extractKernelShapes(sliceSource(content, sym));
    shapesCache.set(key, ks);
    return ks;
  };

  for (const file of graph.indexedFilePaths()) {
    if (opts?.fileFilter && !opts.fileFilter(file)) continue;
    for (const sym of graph.getSymbolsInFile(file)) {
      if (sym.type !== 'function' && sym.type !== 'method') continue;
      const ks = shapesOf(file, sym);
      if (!ks) continue;

      // Rung A — param annotation vs assertion on the same param.
      for (const [name, annotated] of ks.params) {
        const asserted = ks.assertShapes.get(name);
        if (!asserted) continue;
        const conflict = shapeConflict(annotated, asserted);
        if (conflict) {
          issues.push({
            kernel: sym.name,
            file,
            line: sym.startLine + 1,
            kind: 'intra-kernel',
            conflict,
            detail: `param \`${name}\`: ${conflict.detail}`,
          });
        }
      }

      // Rung B — tail-call `return g(...)`: f and g return the same array.
      if (ks.returnSpec) {
        for (const callee of ks.tailReturnCallees) {
          const target = resolveCallee(graph, file, callee);
          if (!target) continue;
          const targetShapes = shapesOf(target.filePath, target);
          if (!targetShapes?.returnSpec) continue;
          const conflict = shapeConflict(ks.returnSpec, targetShapes.returnSpec);
          if (conflict) {
            issues.push({
              kernel: sym.name,
              file,
              line: sym.startLine + 1,
              kind: 'tail-call',
              conflict,
              detail: `returns \`${callee}(...)\` but their return shapes disagree — ${conflict.detail}`,
            });
          }
        }
      }

      // Rung C — cross-call dataflow. Build a var→shape environment from shaped
      // params + single-assignment `var = callee(...)` results, then check each
      // call's positional bare-identifier args against the callee's param shape.
      const env = new Map<string, ShapeSpec>();
      for (const [name, spec] of ks.params) env.set(name, spec);
      for (const [v, callee] of ks.callAssignments) {
        if (!callee) continue; // ambiguous binding
        const target = resolveCallee(graph, file, callee);
        if (!target || target.type !== 'function') continue;
        const tks = shapesOf(target.filePath, target);
        if (tks?.returnSpec) env.set(v, tks.returnSpec);
      }
      for (const cs of ks.callSites) {
        if (cs.hasKwargs) continue; // keyword args break positional matching
        const target = resolveCallee(graph, file, cs.callee);
        // Free functions only — methods carry a leading `self`, shifting positions.
        if (!target || target.type !== 'function') continue;
        const tks = shapesOf(target.filePath, target);
        if (!tks || tks.hasVarargs) continue;
        for (let i = 0; i < cs.args.length; i++) {
          const argName = cs.args[i];
          if (!argName) continue;
          const argShape = env.get(argName);
          const paramSpec = tks.paramOrder[i]?.spec;
          if (!argShape || !paramSpec) continue;
          const conflict = shapeConflict(argShape, paramSpec);
          if (conflict) {
            issues.push({
              kernel: sym.name,
              file,
              line: sym.startLine + 1,
              kind: 'dataflow',
              conflict,
              detail: `argument \`${argName}\` to \`${cs.callee}(...)\` (position ${i}) — ${conflict.detail}`,
            });
          }
        }
      }
    }
  }
  return issues;
}

/** Resolve a tail-call callee to a single definition: prefer same-file, else a
 *  unique workspace definition. Ambiguous same-name callees are skipped
 *  (conservative — no guessed conflict). */
function resolveCallee(graph: SymbolGraph, callerFile: string, name: string): SymbolEntry | null {
  const defs = graph.lookupSymbol(name).filter((d) => d.type === 'function' || d.type === 'method');
  if (defs.length === 0) return null;
  const sameFile = defs.find((d) => d.filePath === callerFile);
  if (sameFile) return sameFile;
  return defs.length === 1 ? defs[0] : null;
}
