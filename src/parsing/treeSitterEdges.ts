/**
 * AST edge extraction for the tree-sitter analyzer. One scope-stack walk per
 * language family attributes calls / type-uses / heritage to the innermost
 * enclosing named symbol (AST-accurate, unlike the regex line-range heuristic).
 * Also holds the C/C++ declarator walker and the public-modifier probes used to
 * decide symbol visibility.
 */

import type { ParsedCall, ParsedTypeRelation, ParsedTypeUse } from '../astContext.js';

/** Minimal structural view of a tree-sitter node used across the extractors. */
export interface AnyNode {
  type: string;
  text: string;
  childCount: number;
  child(i: number): AnyNode | null;
  childForFieldName(name: string): AnyNode | null;
  parent: AnyNode | null;
  startPosition: { row: number };
}

export interface ExtractedEdges {
  calls: ParsedCall[];
  typeRelations: ParsedTypeRelation[];
  typeUses: ParsedTypeUse[];
}

/**
 * Walk a C/C++ declarator chain to find the innermost identifier.
 * function_definition.declarator may be: function_declarator, pointer_declarator,
 * reference_declarator, qualified_identifier, or identifier.
 */
export function walkDeclarator(node: AnyNode): string {
  if (node.type === 'identifier' || node.type === 'field_identifier') {
    return node.text;
  }
  // qualified_identifier: last child is the unqualified name
  if (node.type === 'qualified_identifier') {
    const name = node.childForFieldName('name');
    return name ? name.text : (node.text.split('::').pop() ?? node.text);
  }
  // function_declarator carries the callee in its 'declarator' field
  const inner = node.childForFieldName('declarator');
  if (inner) return walkDeclarator(inner);
  // Fallback: first identifier-type child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'field_identifier')) return child.text;
  }
  return '';
}

// --- AST edge extraction (TS/TSX/JS) ---------------------------------------
// One walk with a scope stack: calls / type-uses / heritage are attributed to
// the innermost enclosing named symbol (AST-accurate, unlike the regex
// line-range heuristic). Member calls (`a.b()`) resolve to the property name to
// match the graph's bare-callee convention.

/** If this node introduces a named scope, its symbol name; else null. */
function scopeName(node: AnyNode): string | null {
  switch (node.type) {
    case 'function_declaration':
    case 'method_definition':
    case 'class_declaration': {
      const n = node.childForFieldName('name');
      return n ? n.text : null;
    }
    case 'variable_declarator': {
      // `const foo = () => {}` / `const foo = function () {}` — attribute the
      // body's calls to `foo`.
      const value = node.childForFieldName('value');
      if (
        value &&
        (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function')
      ) {
        const n = node.childForFieldName('name');
        return n ? n.text : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Callee name for a call_expression: bare identifier, or the property of a
 *  member expression (`this.mint` → `mint`, `helper.process` → `process`). */
function calleeNameOf(callNode: AnyNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

/** type_annotation role from its parent node. */
function typeUseRole(annotation: AnyNode): ParsedTypeUse['role'] {
  const p = annotation.parent?.type;
  if (p === 'required_parameter' || p === 'optional_parameter') return 'param';
  if (p === 'variable_declarator' || p === 'public_field_definition' || p === 'property_signature') return 'variable';
  return 'return'; // direct child of a function/method/arrow signature
}

function collectTypeIdentifiers(node: AnyNode, out: string[]): void {
  if (node.type === 'type_identifier') out.push(node.text);
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectTypeIdentifiers(c, out);
  }
}

export function extractTsEdges(root: AnyNode): ExtractedEdges {
  const calls: ParsedCall[] = [];
  const typeRelations: ParsedTypeRelation[] = [];
  const typeUses: ParsedTypeUse[] = [];
  const scope: string[] = [];
  const current = (): string => scope[scope.length - 1] ?? '<module>';

  const walk = (node: AnyNode): void => {
    const name = scopeName(node);
    if (name) scope.push(name);

    if (node.type === 'call_expression') {
      const callee = calleeNameOf(node);
      if (callee) calls.push({ callerName: current(), calleeName: callee, line: node.startPosition.row + 1 });
    } else if (node.type === 'type_annotation') {
      const names: string[] = [];
      collectTypeIdentifiers(node, names);
      if (names.length > 0) {
        const role = typeUseRole(node);
        for (const t of names)
          typeUses.push({ userName: current(), typeName: t, role, line: node.startPosition.row + 1 });
      }
    } else if (node.type === 'class_declaration') {
      const className = node.childForFieldName('name')?.text;
      if (className) {
        for (let i = 0; i < node.childCount; i++) {
          const heritage = node.child(i);
          if (heritage?.type !== 'class_heritage') continue;
          for (let j = 0; j < heritage.childCount; j++) {
            const clause = heritage.child(j);
            if (!clause) continue;
            const kind = clause.type === 'implements_clause' ? 'implements' : 'extends';
            for (let k = 0; k < clause.childCount; k++) {
              const ref = clause.child(k);
              if (ref && (ref.type === 'identifier' || ref.type === 'type_identifier')) {
                typeRelations.push({ childName: className, parentName: ref.text, kind });
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) walk(c);
    }

    if (name) scope.pop();
  };

  walk(root);
  return { calls, typeRelations, typeUses };
}

// --- Python AST edge extraction --------------------------------------------
// Python node types differ from TS (call vs call_expression, attribute vs
// member_expression, `type` wrapper, superclasses argument_list), so it gets
// its own walk. Closes the gap where the regex analyzer extracted NO Python
// call/type edges at all.

function findChildOfType(node: AnyNode, type: string): AnyNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === type) return c;
  }
  return null;
}

/** Collect `identifier` names anywhere under a node (used for Python `type`
 *  wrappers and base-class lists). */
function collectIdentifiers(node: AnyNode, out: string[]): void {
  if (node.type === 'identifier') out.push(node.text);
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectIdentifiers(c, out);
  }
}

function pyScopeName(node: AnyNode): string | null {
  if (node.type === 'function_definition' || node.type === 'class_definition') {
    const n = node.childForFieldName('name');
    return n ? n.text : null;
  }
  return null;
}

/** Callee name for a Python `call`: bare identifier, or the attribute of an
 *  attribute access (`self.mint` → `mint`, `helper.process` → `process`). */
function pyCalleeName(callNode: AnyNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute') ?? fn.child(fn.childCount - 1);
    return attr && attr.type === 'identifier' ? attr.text : null;
  }
  return null;
}

export function extractPyEdges(root: AnyNode): ExtractedEdges {
  const calls: ParsedCall[] = [];
  const typeRelations: ParsedTypeRelation[] = [];
  const typeUses: ParsedTypeUse[] = [];
  const scope: string[] = [];
  const current = (): string => scope[scope.length - 1] ?? '<module>';

  const addTypes = (typeNode: AnyNode, role: ParsedTypeUse['role'], line: number): void => {
    const names: string[] = [];
    collectIdentifiers(typeNode, names);
    for (const t of names) typeUses.push({ userName: current(), typeName: t, role, line });
  };

  const walk = (node: AnyNode): void => {
    const name = pyScopeName(node);
    if (name) scope.push(name);

    const line = node.startPosition.row + 1;
    if (node.type === 'call') {
      const callee = pyCalleeName(node);
      if (callee) calls.push({ callerName: current(), calleeName: callee, line });
    } else if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
      const t = node.childForFieldName('type') ?? findChildOfType(node, 'type');
      if (t) addTypes(t, 'param', line);
    } else if (node.type === 'assignment') {
      const t = node.childForFieldName('type'); // annotated assignment `x: T = ...`
      if (t) addTypes(t, 'variable', line);
    } else if (node.type === 'function_definition') {
      const rt = node.childForFieldName('return_type');
      if (rt) addTypes(rt, 'return', line);
    } else if (node.type === 'class_definition') {
      const className = node.childForFieldName('name')?.text;
      const supers = node.childForFieldName('superclasses');
      if (className && supers) {
        const bases: string[] = [];
        collectIdentifiers(supers, bases);
        for (const b of bases) typeRelations.push({ childName: className, parentName: b, kind: 'extends' });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) walk(c);
    }

    if (name) scope.pop();
  };

  walk(root);
  return { calls, typeRelations, typeUses };
}

export function hasPublicModifier(node: AnyNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'modifiers' || child.type === 'modifier')) {
      if (child.text.includes('public')) return true;
    }
    // Java/Kotlin: modifier nodes are direct children
    if (child && child.type === 'public') return true;
  }
  return false;
}

export function hasSwiftPublicModifier(node: AnyNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'attribute' && child.text === 'public') return true;
    if (child && child.type === 'modifier' && (child.text === 'public' || child.text === 'open')) return true;
  }
  return false;
}
