/**
 * Tree-sitter-based code analyzer implementing the CodeAnalyzer interface.
 * Supports JS/TS/TSX, Python, Rust, Go, Java, Kotlin, C#, Ruby, Swift,
 * C, C++, Bash, PHP, Lua, Scala, Dart, and Vue.
 */

import * as path from 'path';
import { logger } from '../system/logger.js';
import type { CodeAnalyzer, CodeElement, ParsedFile } from './types.js';
import { SimpleCodeAnalyzer, type ParsedCall, type ParsedTypeRelation, type ParsedTypeUse } from '../astContext.js';
import { createParser, type Parser } from './treeSitterLoader.js';

// Languages whose call/type edges are extracted from the AST below. Everything
// else delegates edge extraction to the regex analyzer (SimpleCodeAnalyzer) so
// switching the indexer to tree-sitter never regresses edge coverage.
const AST_EDGE_LANGUAGES = new Set(['typescript', 'tsx', 'javascript']);

// Map file extensions to tree-sitter language names
const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'c_sharp',
  rb: 'ruby',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  php: 'php',
  lua: 'lua',
  scala: 'scala',
  dart: 'dart',
  vue: 'vue',
};

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXT_TO_LANGUAGE));

// Tree-sitter node type → CodeElement type mapping per language
interface ElementMapping {
  nodeType: string;
  elementType: CodeElement['type'];
  nameField?: string;
  nameNodeType?: string;
}

const LANGUAGE_MAPPINGS: Record<string, ElementMapping[]> = {
  javascript: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'method_definition', elementType: 'method', nameField: 'name' },
    { nodeType: 'export_statement', elementType: 'export' },
    { nodeType: 'import_statement', elementType: 'import' },
  ],
  typescript: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'method_definition', elementType: 'method', nameField: 'name' },
    { nodeType: 'interface_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'type_alias_declaration', elementType: 'type', nameField: 'name' },
    { nodeType: 'enum_declaration', elementType: 'enum', nameField: 'name' },
    { nodeType: 'export_statement', elementType: 'export' },
    { nodeType: 'import_statement', elementType: 'import' },
  ],
  tsx: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'method_definition', elementType: 'method', nameField: 'name' },
    { nodeType: 'interface_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'type_alias_declaration', elementType: 'type', nameField: 'name' },
    { nodeType: 'enum_declaration', elementType: 'enum', nameField: 'name' },
    { nodeType: 'export_statement', elementType: 'export' },
    { nodeType: 'import_statement', elementType: 'import' },
  ],
  python: [
    { nodeType: 'function_definition', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_definition', elementType: 'class', nameField: 'name' },
    { nodeType: 'import_statement', elementType: 'import' },
    { nodeType: 'import_from_statement', elementType: 'import' },
  ],
  rust: [
    { nodeType: 'function_item', elementType: 'function', nameField: 'name' },
    { nodeType: 'struct_item', elementType: 'class', nameField: 'name' },
    { nodeType: 'enum_item', elementType: 'enum', nameField: 'name' },
    { nodeType: 'trait_item', elementType: 'interface', nameField: 'name' },
    { nodeType: 'impl_item', elementType: 'class' },
    { nodeType: 'use_declaration', elementType: 'import' },
  ],
  go: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'method_declaration', elementType: 'method', nameField: 'name' },
    { nodeType: 'type_declaration', elementType: 'class' },
    { nodeType: 'import_declaration', elementType: 'import' },
  ],
  java: [
    { nodeType: 'method_declaration', elementType: 'method', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'interface_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'enum_declaration', elementType: 'enum', nameField: 'name' },
    { nodeType: 'import_declaration', elementType: 'import' },
  ],
  kotlin: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'object_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'interface_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'import_header', elementType: 'import' },
  ],
  c_sharp: [
    { nodeType: 'method_declaration', elementType: 'method', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'interface_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'enum_declaration', elementType: 'enum', nameField: 'name' },
    { nodeType: 'using_directive', elementType: 'import' },
  ],
  ruby: [
    { nodeType: 'method', elementType: 'method', nameField: 'name' },
    { nodeType: 'singleton_method', elementType: 'method', nameField: 'name' },
    { nodeType: 'class', elementType: 'class', nameField: 'name' },
    { nodeType: 'module', elementType: 'interface', nameField: 'name' },
  ],
  swift: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'struct_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'protocol_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'enum_declaration', elementType: 'enum', nameField: 'name' },
    { nodeType: 'import_declaration', elementType: 'import' },
  ],
  bash: [{ nodeType: 'function_definition', elementType: 'function', nameField: 'name' }],
  php: [
    { nodeType: 'function_definition', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'method_declaration', elementType: 'method', nameField: 'name' },
    { nodeType: 'interface_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'namespace_use_declaration', elementType: 'import' },
  ],
  lua: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'local_function', elementType: 'function', nameField: 'name' },
    { nodeType: 'method_index_expression', elementType: 'method' },
  ],
  scala: [
    { nodeType: 'function_definition', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_definition', elementType: 'class', nameField: 'name' },
    { nodeType: 'object_definition', elementType: 'class', nameField: 'name' },
    { nodeType: 'trait_definition', elementType: 'interface', nameField: 'name' },
    { nodeType: 'import_declaration', elementType: 'import' },
  ],
  dart: [
    { nodeType: 'function_signature', elementType: 'function', nameField: 'name' },
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_definition', elementType: 'class', nameField: 'name' },
    { nodeType: 'mixin_declaration', elementType: 'interface', nameField: 'name' },
    { nodeType: 'import_specification', elementType: 'import' },
  ],
  // Vue SFCs: function/class nodes inside <script> blocks use the same types as JavaScript
  vue: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'method_definition', elementType: 'method', nameField: 'name' },
    { nodeType: 'export_statement', elementType: 'export' },
    { nodeType: 'import_statement', elementType: 'import' },
  ],
  // C and C++ function names are nested in declarator chains — handled via walkDeclarator()
  c: [
    { nodeType: 'function_definition', elementType: 'function' },
    { nodeType: 'struct_specifier', elementType: 'class', nameField: 'name' },
    { nodeType: 'enum_specifier', elementType: 'enum', nameField: 'name' },
    { nodeType: 'preproc_include', elementType: 'import' },
  ],
  cpp: [
    { nodeType: 'function_definition', elementType: 'function' },
    { nodeType: 'class_specifier', elementType: 'class', nameField: 'name' },
    { nodeType: 'struct_specifier', elementType: 'class', nameField: 'name' },
    { nodeType: 'enum_specifier', elementType: 'enum', nameField: 'name' },
    { nodeType: 'namespace_definition', elementType: 'class', nameField: 'name' },
    { nodeType: 'preproc_include', elementType: 'import' },
  ],
};

/**
 * Walk a C/C++ declarator chain to find the innermost identifier.
 * function_definition.declarator may be: function_declarator, pointer_declarator,
 * reference_declarator, qualified_identifier, or identifier.
 */
function walkDeclarator(node: AnyNode): string {
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

interface AnyNode {
  type: string;
  text: string;
  childCount: number;
  child(i: number): AnyNode | null;
  childForFieldName(name: string): AnyNode | null;
  parent: AnyNode | null;
  startPosition: { row: number };
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

interface ExtractedEdges {
  calls: ParsedCall[];
  typeRelations: ParsedTypeRelation[];
  typeUses: ParsedTypeUse[];
}

function extractTsEdges(root: AnyNode): ExtractedEdges {
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

function hasPublicModifier(node: AnyNode): boolean {
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

function hasSwiftPublicModifier(node: AnyNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'attribute' && child.text === 'public') return true;
    if (child && child.type === 'modifier' && (child.text === 'public' || child.text === 'open')) return true;
  }
  return false;
}

class TreeSitterCodeAnalyzer implements CodeAnalyzer {
  readonly supportedExtensions = SUPPORTED_EXTENSIONS;
  private parsers = new Map<string, Parser>();

  constructor(parsers: Map<string, Parser>) {
    this.parsers = parsers;
  }

  parseFileContent(filePath: string, content: string): ParsedFile {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const langName = EXT_TO_LANGUAGE[ext];
    const parser = langName ? this.parsers.get(langName) : undefined;

    if (!parser || !langName) {
      return { filePath, elements: [], content };
    }

    const tree = parser.parse(content);
    const mappings = LANGUAGE_MAPPINGS[langName] || [];
    const elements: CodeElement[] = [];
    const lines = content.split('\n');

    // Walk the tree and extract elements matching our mappings
    const cursor = tree.walk();
    const visit = (): void => {
      const node = cursor.currentNode;

      for (const mapping of mappings) {
        if (node.type === mapping.nodeType) {
          let name = '';

          // Try to get name from the designated field
          if (mapping.nameField) {
            const nameNode = node.childForFieldName(mapping.nameField);
            if (nameNode) {
              name = nameNode.text;
            }
          }

          // C/C++ function names are buried in a declarator chain:
          // function_definition → declarator (pointer_declarator | function_declarator) → ... → identifier
          if (!name && (langName === 'c' || langName === 'cpp') && node.type === 'function_definition') {
            const declarator = node.childForFieldName('declarator');
            if (declarator) name = walkDeclarator(declarator);
          }

          // For exports, try to get the name from the inner declaration
          if (!name && mapping.elementType === 'export') {
            const inner = node.childForFieldName('declaration') || node.childForFieldName('value');
            if (inner) {
              const innerName = inner.childForFieldName('name');
              name = innerName ? innerName.text : inner.text.slice(0, 50);
            }
          }

          // For imports, extract the source module
          if (!name && mapping.elementType === 'import') {
            const source =
              node.childForFieldName('source') || node.childForFieldName('path') || node.childForFieldName('name'); // Java import_declaration uses 'name'
            name = source ? source.text.replace(/['"]/g, '') : node.text.slice(0, 80);
          }

          // For Go type declarations and Rust impl, get the type name
          if (!name && (node.type === 'type_declaration' || node.type === 'impl_item')) {
            // Walk children to find the type identifier
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (
                child &&
                (child.type === 'type_spec' || child.type === 'type_identifier' || child.type === 'generic_type')
              ) {
                const nameChild = child.childForFieldName('name') || child;
                name = nameChild.text.split(/[\s<{]/)[0];
                break;
              }
            }
          }

          if (!name) name = node.type;

          const startLine = node.startPosition.row;
          const endLine = node.endPosition.row;
          const elementContent = lines.slice(startLine, endLine + 1).join('\n');

          // Check if this element is exported
          let exported = false;
          if (mapping.elementType === 'export') {
            exported = true;
          } else if (node.parent?.type === 'export_statement') {
            exported = true;
          } else if (langName === 'go' && name.length > 0 && name[0] === name[0].toUpperCase()) {
            exported = true; // Go convention: uppercase = exported
          } else if (langName === 'rust' && node.previousSibling?.type === 'visibility_modifier') {
            exported = true;
          } else if (
            (langName === 'java' || langName === 'c_sharp' || langName === 'kotlin') &&
            hasPublicModifier(node)
          ) {
            exported = true;
          } else if (langName === 'swift' && hasSwiftPublicModifier(node)) {
            exported = true;
          }

          // Extract import bindings
          let bindings: string[] | undefined;
          if (mapping.elementType === 'import') {
            bindings = [];
            // Look for named imports
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child?.type === 'import_clause' || child?.type === 'named_imports') {
                for (let j = 0; j < child.childCount; j++) {
                  const specifier = child.child(j);
                  if (specifier?.type === 'import_specifier') {
                    const nameNode = specifier.childForFieldName('name');
                    if (nameNode) bindings.push(nameNode.text);
                  }
                }
              }
            }
          }

          elements.push({
            type: mapping.elementType,
            name,
            startLine,
            endLine,
            content: elementContent,
            relevanceScore: 0,
            exported,
            ...(bindings && bindings.length > 0 ? { bindings } : {}),
          });

          break; // Don't match multiple mappings for the same node
        }
      }

      // Recurse into children (but not too deep for performance)
      if (cursor.gotoFirstChild()) {
        do {
          visit();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };

    visit();

    // Edges: AST-accurate for TS/JS; regex fallback for every other language so
    // switching the indexer to tree-sitter never loses edge coverage.
    let calls: ParsedCall[] | undefined;
    let typeRelations: ParsedTypeRelation[] | undefined;
    let typeUses: ParsedTypeUse[] | undefined;
    if (AST_EDGE_LANGUAGES.has(langName)) {
      const edges = extractTsEdges(tree.rootNode as unknown as AnyNode);
      calls = edges.calls.length > 0 ? edges.calls : undefined;
      typeRelations = edges.typeRelations.length > 0 ? edges.typeRelations : undefined;
      typeUses = edges.typeUses.length > 0 ? edges.typeUses : undefined;
    } else {
      const regex = SimpleCodeAnalyzer.parseFileContent(filePath, content);
      calls = regex.calls;
      typeRelations = regex.typeRelations;
      typeUses = regex.typeUses;
    }

    tree.delete();

    return { filePath, elements, content, calls, typeRelations, typeUses };
  }

  findRelevantElements(parsedFile: ParsedFile, query: string): CodeElement[] {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

    for (const el of parsedFile.elements) {
      let score = 0;
      const nameLower = el.name.toLowerCase();

      // Name match (strongest signal)
      if (queryTerms.some((term) => nameLower.includes(term))) {
        score += 0.5;
      }

      // Content match
      const contentLower = el.content.toLowerCase();
      if (queryTerms.some((term) => contentLower.includes(term))) {
        score += 0.3;
      }

      // Type boost — functions/classes are more relevant than imports
      if (el.type === 'function' || el.type === 'method') score += 0.2;
      if (el.type === 'class' || el.type === 'interface') score += 0.3;

      el.relevanceScore = score;
    }

    return parsedFile.elements
      .filter((el) => el.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  extractRelevantContent(parsedFile: ParsedFile, relevantElements: CodeElement[]): string {
    if (relevantElements.length === 0) return parsedFile.content;

    const lines = parsedFile.content.split('\n');
    const parts: string[] = [];
    let lastEnd = -1;

    // Sort by line number for sequential extraction
    const sorted = [...relevantElements].sort((a, b) => a.startLine - b.startLine);

    for (const el of sorted) {
      // Add separator if there's a gap
      const start = Math.max(0, el.startLine - 1); // 1 line of context
      if (lastEnd >= 0 && start > lastEnd + 1) {
        parts.push('...');
      }

      const end = Math.min(lines.length - 1, el.endLine + 1);
      parts.push(lines.slice(start, end + 1).join('\n'));
      lastEnd = end;
    }

    return parts.join('\n');
  }
}

/**
 * Create a TreeSitterCodeAnalyzer with pre-loaded parsers for all supported languages.
 */
export async function createTreeSitterAnalyzer(wasmDir: string): Promise<CodeAnalyzer> {
  const parsers = new Map<string, Parser>();

  // Load all available language parsers in parallel
  const languages = Object.values(EXT_TO_LANGUAGE).filter(
    (v, i, arr) => arr.indexOf(v) === i, // dedupe
  );

  const results = await Promise.allSettled(
    languages.map(async (lang) => {
      const parser = await createParser(wasmDir, lang);
      return { lang, parser };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      parsers.set(result.value.lang, result.value.parser);
    } else {
      logger.warn(`[SideCar] Failed to load tree-sitter grammar:`, result.reason);
    }
  }

  if (parsers.size === 0) {
    throw new Error('No tree-sitter grammars loaded');
  }

  logger.info(`[SideCar] Tree-sitter loaded with ${parsers.size} languages: ${[...parsers.keys()].join(', ')}`);
  return new TreeSitterCodeAnalyzer(parsers);
}
