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
import {
  type AnyNode,
  walkDeclarator,
  extractTsEdges,
  extractPyEdges,
  hasPublicModifier,
  hasSwiftPublicModifier,
} from './treeSitterEdges.js';

// Languages whose call/type edges are extracted from the AST below (TS-family
// node types). Python has its own extractor (different node types). Everything
// else delegates edge extraction to the regex analyzer (SimpleCodeAnalyzer) so
// switching the indexer to tree-sitter never regresses edge coverage.
const TS_EDGE_LANGUAGES = new Set(['typescript', 'tsx', 'javascript']);

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
  /**
   * Emit one element per descendant of this type rather than one for the node.
   * A declaration can bind several names (`const A = 1, B = 2`) and the names
   * live on nested declarators, not on a field of the declaration itself — the
   * `nodeType` + `nameField` shape cannot express that. Mappings carrying this
   * are also restricted to top-level nodes: a declaration inside a function
   * body is not an addressable symbol.
   */
  perDeclarator?: string;
}

const LANGUAGE_MAPPINGS: Record<string, ElementMapping[]> = {
  javascript: [
    { nodeType: 'function_declaration', elementType: 'function', nameField: 'name' },
    { nodeType: 'class_declaration', elementType: 'class', nameField: 'name' },
    { nodeType: 'method_definition', elementType: 'method', nameField: 'name' },
    { nodeType: 'lexical_declaration', elementType: 'variable', perDeclarator: 'variable_declarator' },
    { nodeType: 'variable_declaration', elementType: 'variable', perDeclarator: 'variable_declarator' },
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
    { nodeType: 'lexical_declaration', elementType: 'variable', perDeclarator: 'variable_declarator' },
    { nodeType: 'variable_declaration', elementType: 'variable', perDeclarator: 'variable_declarator' },
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
    { nodeType: 'lexical_declaration', elementType: 'variable', perDeclarator: 'variable_declarator' },
    { nodeType: 'variable_declaration', elementType: 'variable', perDeclarator: 'variable_declarator' },
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
          if (mapping.perDeclarator) {
            // One declaration, N bound names. Restricted to the top level:
            // `program`, or an `export_statement` directly under it. A
            // declaration in a function body is not an addressable symbol and
            // indexing them would inflate the graph for no query value.
            const parent = node.parent;
            const topLevel =
              parent?.type === 'program' || (parent?.type === 'export_statement' && parent.parent?.type === 'program');
            if (!topLevel) break;

            const startLine = node.startPosition.row;
            const endLine = node.endPosition.row;
            const declContent = lines.slice(startLine, endLine + 1).join('\n');
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child?.type !== mapping.perDeclarator) continue;
              const nameNode = child.childForFieldName('name');
              // Destructuring binds via object_pattern / array_pattern, which
              // have no single identifier to attribute a range to. Deliberately
              // skipped rather than guessed at.
              if (!nameNode || nameNode.type !== 'identifier') continue;
              // `const handle = () => {}` is a function to everyone who reads
              // it, and the regex analyzer already indexes it as one. Typing it
              // `variable` here would make a symbol's kind depend on which
              // analyzer happened to run.
              const value = child.childForFieldName('value')?.type;
              const isFunctionValued =
                value === 'arrow_function' || value === 'function_expression' || value === 'function';
              elements.push({
                type: isFunctionValued ? 'function' : mapping.elementType,
                name: nameNode.text,
                startLine,
                endLine,
                content: declContent,
                relevanceScore: 0,
                exported: parent?.type === 'export_statement',
              });
            }
            break;
          }

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

    // Edges: AST-accurate for TS/JS + Python; regex fallback for every other
    // language so switching the indexer to tree-sitter never loses edge coverage.
    let calls: ParsedCall[] | undefined;
    let typeRelations: ParsedTypeRelation[] | undefined;
    let typeUses: ParsedTypeUse[] | undefined;
    const astEdges =
      langName === 'python'
        ? extractPyEdges(tree.rootNode as unknown as AnyNode)
        : TS_EDGE_LANGUAGES.has(langName)
          ? extractTsEdges(tree.rootNode as unknown as AnyNode)
          : null;
    if (astEdges) {
      calls = astEdges.calls.length > 0 ? astEdges.calls : undefined;
      typeRelations = astEdges.typeRelations.length > 0 ? astEdges.typeRelations : undefined;
      typeUses = astEdges.typeUses.length > 0 ? astEdges.typeUses : undefined;
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

  const languages = Object.values(EXT_TO_LANGUAGE).filter(
    (v, i, arr) => arr.indexOf(v) === i, // dedupe
  );

  // Load grammars SERIALLY, not in parallel. web-tree-sitter's `Language.load`
  // mutates a shared Emscripten runtime and is NOT concurrency-safe: parallel
  // loads corrupt each other's dynamic-linking symbol tables, so a load resolves
  // another grammar's scanner export and fails. This surfaced only under the
  // Linux CI runner's timing (loading 'python' failed on 'rust'/'tsx' exports);
  // macOS happened to survive the race. Serial load makes it deterministic.
  const failures: string[] = [];
  for (const lang of languages) {
    try {
      parsers.set(lang, await createParser(wasmDir, lang));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${lang}: ${reason}`);
      logger.warn(`[SideCar] Failed to load tree-sitter grammar '${lang}': ${reason}`);
      // A grammar compiled for a newer tree-sitter ABI than web-tree-sitter
      // supports is a benign skip (that language just isn't analyzed). Anything
      // else is an unexpected degradation — the symbol graph / PKI / impact
      // analysis silently go empty — so surface it loudly.
      if (!/Incompatible language version/i.test(reason)) {
        // eslint-disable-next-line no-console
        console.error(`[SideCar][tree-sitter] GRAMMAR LOAD FAILED — ${lang}: ${reason}`);
      }
    }
  }

  if (parsers.size === 0) {
    throw new Error(`No tree-sitter grammars loaded. Failures:\n${failures.join('\n')}`);
  }

  logger.info(`[SideCar] Tree-sitter loaded with ${parsers.size} languages: ${[...parsers.keys()].join(', ')}`);
  return new TreeSitterCodeAnalyzer(parsers);
}
