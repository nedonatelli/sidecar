/**
 * Tree-sitter-based code analyzer implementing the CodeAnalyzer interface.
 * Provides accurate AST parsing for JS/TS, Python, Rust, and Go.
 */

import * as path from 'path';
import type { CodeAnalyzer, CodeElement, ParsedFile } from './types.js';
import { createParser, type Parser } from './treeSitterLoader.js';

// Map file extensions to tree-sitter language names
const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
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
          let name = '';

          // Try to get name from the designated field
          if (mapping.nameField) {
            const nameNode = node.childForFieldName(mapping.nameField);
            if (nameNode) {
              name = nameNode.text;
            }
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
            const source = node.childForFieldName('source') || node.childForFieldName('path');
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
    tree.delete();

    return { filePath, elements, content };
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
      console.warn(`[SideCar] Failed to load tree-sitter grammar:`, result.reason);
    }
  }

  if (parsers.size === 0) {
    throw new Error('No tree-sitter grammars loaded');
  }

  console.log(`[SideCar] Tree-sitter loaded with ${parsers.size} languages: ${[...parsers.keys()].join(', ')}`);
  return new TreeSitterCodeAnalyzer(parsers);
}
