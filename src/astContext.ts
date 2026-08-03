/**
 * AST-based context selection for smarter code analysis
 * This module provides functionality to identify relevant code elements
 * (functions, classes, methods) based on query content.
 */

import {
  declaredNames,
  findBlockEnd,
  findDeclarationEnd,
  findIndentEnd,
  parseImport,
  resolveImportPath,
} from './astContext/importScan.js';
import { findRelevantElements, extractRelevantContent } from './astContext/relevance.js';

export interface CodeElement {
  type: 'function' | 'class' | 'method' | 'variable' | 'import' | 'export' | 'interface' | 'type' | 'enum';
  name: string;
  startLine: number;
  endLine: number;
  content: string;
  relevanceScore: number;
  /** Whether the symbol has an `export` modifier. */
  exported?: boolean;
  /** For imports: the named bindings imported (e.g. ['A', 'B'] from `import { A, B } from ...`). */
  bindings?: string[];
}

/** A call site detected during parsing. */
export interface ParsedCall {
  callerName: string; // enclosing function/method name, or '<module>' for top-level
  calleeName: string;
  line: number; // 1-based
}

/** A type relationship detected during parsing. */
export interface ParsedTypeRelation {
  childName: string;
  parentName: string;
  kind: 'extends' | 'implements';
}

/** A use of a named type in a signature/variable (return, param, or variable annotation). */
export interface ParsedTypeUse {
  userName: string; // enclosing symbol that references the type, or '<module>'
  typeName: string;
  role: 'return' | 'param' | 'variable';
  line: number; // 1-based
}

export interface ParsedFile {
  filePath: string;
  elements: CodeElement[];
  content: string;
  calls?: ParsedCall[];
  typeRelations?: ParsedTypeRelation[];
  typeUses?: ParsedTypeUse[];
}

// `: Type` annotations (params, fields, variables). Capitalized head only, so
// primitives (string, number, boolean, void, any, …) are skipped by construction.
const TYPE_ANNOT_PATTERN = /:\s*([A-Z][\w$.]*)/g;
// `Foo<Bar>` generic arguments — capture the capitalized argument head.
const GENERIC_ARG_PATTERN = /<\s*([A-Z][\w$.]*)/g;
// Common built-in/library PascalCase types that are never workspace symbols.
// Skipping them keeps the persisted edge set lean (the impact query would
// filter them anyway, since no workspace symbol is defined by these names).
const BUILTIN_TYPE_NAMES = new Set([
  'Promise',
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'ReturnType',
  'Parameters',
  'Awaited',
  'Object',
  'Function',
  'Date',
  'RegExp',
  'Error',
  'Symbol',
  'BigInt',
  'String',
  'Number',
  'Boolean',
  'Iterable',
  'Iterator',
  'Generator',
  'AsyncGenerator',
  'Uint8Array',
  'ArrayBuffer',
  // Python typing
  'List',
  'Dict',
  'Tuple',
  'Optional',
  'Union',
  'Any',
  'Callable',
  'Sequence',
  'Mapping',
  'Type',
  'Final',
]);

/**
 * Simple code element extractor for common languages
 * This is a lightweight implementation that doesn't require heavy tree-sitter dependencies
 */
export class SimpleCodeAnalyzer {
  /**
   * Best-effort resolution of a relative import path to a file path.
   * Tries common extensions (.ts, .tsx, .js, .jsx) and index files.
   */
  static resolveImportPath(importerFile: string, moduleSpecifier: string): string | null {
    return resolveImportPath(importerFile, moduleSpecifier);
  }

  /**
   * Parse a file and extract code elements with their full bodies.
   */
  static parseFileContent(filePath: string, content: string): ParsedFile {
    const elements: CodeElement[] = [];
    // A byte-order mark sits before the first character, so every `^`-anchored
    // pattern below misses whatever is declared on line 1. Tree-sitter ignores
    // it, so leaving it in made the two analyzers disagree about the same file.
    const lines = content.replace(/^\uFEFF/, '').split('\n');
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

    // Determine language family once to avoid testing irrelevant patterns per line.
    const lang:
      | 'js'
      | 'py'
      | 'rs'
      | 'go'
      | 'jvm'
      | 'c_cpp'
      | 'cs'
      | 'rb'
      | 'swift'
      | 'bash'
      | 'lua'
      | 'scala'
      | 'php'
      | 'other' = ['.js', '.ts', '.jsx', '.tsx', '.vue'].includes(ext)
      ? 'js'
      : ext === '.py'
        ? 'py'
        : ext === '.rs'
          ? 'rs'
          : ext === '.go'
            ? 'go'
            : ['.java', '.kt', '.kts'].includes(ext)
              ? 'jvm'
              : ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh'].includes(ext)
                ? 'c_cpp'
                : ext === '.cs'
                  ? 'cs'
                  : ext === '.rb'
                    ? 'rb'
                    : ext === '.swift'
                      ? 'swift'
                      : ['.sh', '.bash', '.zsh'].includes(ext)
                        ? 'bash'
                        : ext === '.lua'
                          ? 'lua'
                          : ext === '.scala'
                            ? 'scala'
                            : ['.php', '.dart'].includes(ext)
                              ? 'php'
                              : 'other';

    const usesBraces = lang !== 'py' && lang !== 'rb';
    const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch']);

    // Track call sites and type relations for the symbol graph
    const calls: ParsedCall[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const typeUses: ParsedTypeUse[] = [];
    // Regex for function calls: identifier followed by ( — excludes keywords/declarations
    const CALL_PATTERN = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
    const SKIP_CALL_NAMES = new Set([
      ...CONTROL_KEYWORDS,
      'function',
      'class',
      'import',
      'export',
      'return',
      'new',
      'typeof',
      'instanceof',
      'delete',
      'void',
      'throw',
      'async',
      'await',
      'yield',
      'super',
      'this',
      'require',
    ]);

    // Helper: build content string from line range (deferred to avoid O(n) per element during scan)
    const buildContent = (start: number, end: number) => lines.slice(start, end + 1).join('\n');

    // Last line covered by an emitted top-level declaration. A top-level
    // declaration cannot contain another, so anything inside one is not a
    // symbol — without this, a `const SWIFT_SOURCE = \`…\`` holding another
    // language's source yields a symbol for every `let` in the embedded text.
    let declaredThrough = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // --- Language-specific function/method patterns ---
      if (lang === 'js') {
        const isExported = /^\s*export\s/.test(line);

        // Function declarations, including generators.
        //
        // The gate used to be `includes('function ')`, which is false for
        // `function*` — the star sits where the space would be. Every exported
        // generator was therefore skipped: 40 of them across 17 files, and
        // they are the streaming core (parseSse, streamOpenAiSse,
        // translateAnthropicStream), so find_references on any returned
        // nothing. tree-sitter missed the same declarations for an unrelated
        // reason — `function*` is its own node type, not a modifier on
        // function_declaration — so both analyzers had to be fixed.
        //
        // The alternation is what keeps `functionfoo` from matching: a name
        // must be separated by whitespace or by the star, never by neither.
        {
          const match = line.match(/\bfunction(?:\s+|\s*\*\s*)([a-zA-Z_$][\w$]*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: isExported,
            });
          }
        }
        // Arrow / const function expressions
        const arrowMatch = line.match(
          /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(|[a-zA-Z_$])/,
        );
        // The next-line lookahead is for an arrow whose parameter list wraps:
        // `const fn = (\n  a,\n) => …`. It only applies while that list is still
        // open — without the guard, any declaration sitting above an unrelated
        // arrow was read as a function, which silently swallowed its symbol.
        const parensOpen = (line.match(/\(/g)?.length ?? 0) > (line.match(/\)/g)?.length ?? 0);
        const isArrowFunction = !!arrowMatch && (line.includes('=>') || (parensOpen && !!lines[i + 1]?.includes('=>')));
        if (arrowMatch && isArrowFunction) {
          const endLine = line.includes('{') ? findBlockEnd(lines, i) : i;
          elements.push({
            type: 'function',
            name: arrowMatch[1],
            startLine: i,
            endLine,
            content: buildContent(i, endLine),
            relevanceScore: 0.8,
            exported: isExported,
          });
        }

        // Top-level variable declarations. `^` with no leading whitespace is
        // this analyzer's only available proxy for "top level" — it has no
        // scope tracking — and it matches the spec: declarations nested in a
        // function body are deliberately not symbols.
        const isDeclaration = /^(?:export\s+)?(?:const|let|var)\s+[a-zA-Z_$]/.test(line);
        if (
          isDeclaration &&
          i > declaredThrough &&
          !/^(?:export\s+)?(?:const\s+)?enum\s/.test(line) &&
          !isArrowFunction
        ) {
          const endLine = findDeclarationEnd(lines, i);
          declaredThrough = endLine;
          const content = buildContent(i, endLine);
          for (const name of declaredNames(content)) {
            elements.push({
              type: 'variable',
              name,
              startLine: i,
              endLine,
              content,
              relevanceScore: 0.6,
              exported: isExported,
            });
          }
        }

        // Interface declarations (TypeScript)
        if (line.includes('interface ')) {
          const match = line.match(/interface\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'interface',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.7,
              exported: isExported,
            });
          }
        }

        // Type alias declarations (TypeScript)
        if (line.includes('type ') && line.match(/^\s*(?:export\s+)?type\s+([a-zA-Z_$][\w$]*)\s*[=<]/)) {
          const match = line.match(/type\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            // Type aliases can be single-line or multi-line
            const endLine = line.includes('{') ? findBlockEnd(lines, i) : i;
            elements.push({
              type: 'type',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.6,
              exported: isExported,
            });
          }
        }

        // Enum declarations (TypeScript)
        if (line.includes('enum ')) {
          const match = line.match(/(?:const\s+)?enum\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'enum',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.6,
              exported: isExported,
            });
          }
        }
      } else if (lang === 'py') {
        if (line.match(/^\s*(?:async\s+)?def\s/)) {
          const match = line.match(/def\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findIndentEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'rs') {
        if (line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s/)) {
          const match = line.match(/fn\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'go') {
        if (line.match(/^func\s/)) {
          const match = line.match(/func\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'jvm') {
        if (line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:fun\s|[\w<>\[\]]+\s+\w+\s*\()/)) {
          const match = line.match(/(?:fun\s+)?([a-zA-Z_]\w*)\s*\(/);
          if (match && !CONTROL_KEYWORDS.has(match[1])) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'method',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'c_cpp') {
        // struct/union definitions
        if (line.match(/^\s*(?:typedef\s+)?(?:struct|union)\s+([a-zA-Z_]\w*)/)) {
          const match = line.match(/(?:struct|union)\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'class',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
        // Function definitions: return-type name( — require uppercase/lowercase identifier before ( not preceded by keyword
        const fnMatch = line.match(
          /^(?![\s]*(if|for|while|switch|return|#))[\w\s*&:<>]+?\b([a-zA-Z_][\w:]*)\s*\([^)]*\)\s*(?:\{|$)/,
        );
        if (fnMatch && !CONTROL_KEYWORDS.has(fnMatch[2]) && fnMatch[2] !== 'if') {
          const endLine = line.includes('{') ? findBlockEnd(lines, i) : i;
          elements.push({
            type: 'function',
            name: fnMatch[2],
            startLine: i,
            endLine,
            content: buildContent(i, endLine),
            relevanceScore: 0.8,
          });
        }
      } else if (lang === 'cs') {
        // namespace declarations
        if (line.match(/^\s*namespace\s+/)) {
          const match = line.match(/namespace\s+([\w.]+)/);
          if (match)
            elements.push({
              type: 'class',
              name: match[1],
              startLine: i,
              endLine: i,
              content: line,
              relevanceScore: 0.5,
            });
        }
        // interface declarations
        if (line.match(/^\s*(?:public|private|protected|internal|)?\s*interface\s+/)) {
          const match = line.match(/interface\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'interface',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: /public/.test(line),
            });
          }
        }
        // method/function declarations: visibility? static? returnType Name(
        if (
          line.match(/^\s*(?:public|private|protected|internal|static|override|virtual|async|abstract)\s+/) &&
          line.includes('(')
        ) {
          const match = line.match(/\b([a-zA-Z_]\w*)\s*\(/);
          if (match && !CONTROL_KEYWORDS.has(match[1]) && match[1] !== 'if') {
            const endLine = line.includes('{') ? findBlockEnd(lines, i) : i;
            elements.push({
              type: 'method',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: /public/.test(line),
            });
          }
        }
      } else if (lang === 'rb') {
        // def method_name or def self.method_name
        if (line.match(/^\s*def\s+/)) {
          const match = line.match(/def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/);
          if (match) {
            const endLine = findIndentEnd(lines, i);
            elements.push({
              type: 'method',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
        // module declarations
        if (line.match(/^\s*module\s+/)) {
          const match = line.match(/module\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findIndentEnd(lines, i);
            elements.push({
              type: 'interface',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.7,
            });
          }
        }
      } else if (lang === 'swift') {
        const isPublic = /\b(?:public|open)\b/.test(line);
        // func declarations
        if (
          line.match(/^\s*(?:public|private|internal|open|fileprivate|static|class|override|mutating|async)?\s*func\s+/)
        ) {
          const match = line.match(/func\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: isPublic,
            });
          }
        }
        // struct, protocol, enum declarations
        if (line.match(/^\s*(?:public\s+|private\s+|internal\s+|open\s+)?(?:struct|protocol|enum)\s+/)) {
          const typeMatch = line.match(/\b(struct|protocol|enum)\s+([a-zA-Z_]\w*)/);
          if (typeMatch) {
            const elType: CodeElement['type'] =
              typeMatch[1] === 'protocol' ? 'interface' : typeMatch[1] === 'enum' ? 'enum' : 'class';
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: elType,
              name: typeMatch[2],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: isPublic,
            });
          }
        }
      } else if (lang === 'bash') {
        // function name { or name() {
        const fnMatch = line.match(/^\s*(?:function\s+)?([a-zA-Z_][\w-]*)\s*\(\s*\)/);
        if (fnMatch || line.match(/^\s*function\s+([a-zA-Z_][\w-]*)\s*\{?/)) {
          const match = fnMatch ?? line.match(/function\s+([a-zA-Z_][\w-]*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'lua') {
        // function name( or local function name(
        if (line.match(/^\s*(?:local\s+)?function\s+/)) {
          const match = line.match(/function\s+([\w.]+)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'scala') {
        // def name
        if (line.match(/^\s*(?:override\s+)?(?:def|val|var)\s+/)) {
          const match = line.match(/\bdef\s+([a-zA-Z_]\w*)/);
          if (match && !CONTROL_KEYWORDS.has(match[1])) {
            const endLine = line.includes('=') && !line.includes('{') ? i : findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
        // object/trait declarations
        if (line.match(/^\s*(?:case\s+)?(?:object|trait)\s+/)) {
          const match = line.match(/(?:object|trait)\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'class',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'php') {
        // function / method declarations
        if (line.match(/^\s*(?:public|private|protected|static|abstract|final)?\s*function\s+/)) {
          const match = line.match(/function\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: /public/.test(line),
            });
          }
        }
      }

      // --- Class definitions (most languages) ---
      // Accepts: `class Foo`, `export class Foo`, `public class Foo`, `final class Foo`, etc.
      if (
        line.match(/\bclass\s+[a-zA-Z_$]/) &&
        line.match(/^\s*(?:(?:export|public|private|protected|internal|final|abstract|sealed|static|case)\s+)*class\s/)
      ) {
        const match = line.match(/class\s+([a-zA-Z_$][\w$]*)/);
        if (match) {
          const isExportedClass = /\b(?:export|public)\b/.test(line);
          const endLine = usesBraces ? findBlockEnd(lines, i) : findIndentEnd(lines, i);
          elements.push({
            type: 'class',
            name: match[1],
            startLine: i,
            endLine,
            content: buildContent(i, endLine),
            relevanceScore: 0.9,
            exported: isExportedClass,
          });
        }
      }

      // --- Import statements with binding extraction ---
      if (line.includes('import') && line.match(/^\s*import\s/)) {
        const parsed = parseImport(line, lines, i);
        if (parsed) {
          elements.push({
            type: 'import',
            name: parsed.modulePath,
            startLine: i,
            endLine: parsed.endLine,
            content: buildContent(i, parsed.endLine),
            relevanceScore: 0.3,
            bindings: parsed.bindings,
          });
          // Skip past multi-line imports
          if (parsed.endLine > i) i = parsed.endLine;
        } else if (line.includes('from')) {
          // Fallback for unrecognized import patterns
          const match = line.match(/import\s+(?:.*\s+from\s+)?['"](.*?)['"]/);
          if (match) {
            elements.push({
              type: 'import',
              name: match[1],
              startLine: i,
              endLine: i,
              content: line,
              relevanceScore: 0.3,
            });
          }
        }
      }
      if (line.includes('export') && line.includes('from') && line.match(/^\s*export\s/)) {
        const match = line.match(/export\s+(?:.*\s+from\s+)?['"](.*?)['"]/);
        if (match) {
          elements.push({
            type: 'export',
            name: match[1],
            startLine: i,
            endLine: i,
            content: line,
            relevanceScore: 0.3,
          });
        }
      }
    }

    // --- Second pass: extract call sites and type relations ---
    // Build scope intervals from detected elements for call attribution
    const scopeIntervals = elements
      .filter((el) => el.type === 'function' || el.type === 'method' || el.type === 'class')
      .map((el) => ({ name: el.name, start: el.startLine, end: el.endLine }))
      .sort((a, b) => a.start - b.start);

    const findScope = (lineIdx: number): string => {
      // Return the innermost scope containing this line
      let best = '<module>';
      for (const s of scopeIntervals) {
        if (lineIdx >= s.start && lineIdx <= s.end) best = s.name;
      }
      return best;
    };

    if (lang === 'js' || lang === 'jvm') {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip import/export/comment lines
        if (
          trimmed.startsWith('import ') ||
          trimmed.startsWith('export ') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('*')
        )
          continue;

        // Extract function calls
        CALL_PATTERN.lastIndex = 0;
        let callMatch: RegExpExecArray | null;
        while ((callMatch = CALL_PATTERN.exec(line)) !== null) {
          const callee = callMatch[1];
          if (!SKIP_CALL_NAMES.has(callee)) {
            calls.push({
              callerName: findScope(i),
              calleeName: callee,
              line: i + 1,
            });
          }
        }
      }

      // Extract type relations from class/interface declarations
      for (const el of elements) {
        if (el.type === 'class' || el.type === 'interface') {
          const declLine = lines[el.startLine] || '';
          const extendsMatch = declLine.match(/\bextends\s+([a-zA-Z_$][\w$]*)/);
          if (extendsMatch) {
            typeRelations.push({ childName: el.name, parentName: extendsMatch[1], kind: 'extends' });
          }
          const implMatch = declLine.match(/\bimplements\s+([\w$,\s]+)/);
          if (implMatch) {
            const parents = implMatch[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            for (const p of parents) {
              const name = p.match(/^([a-zA-Z_$][\w$]*)/)?.[1];
              if (name) typeRelations.push({ childName: el.name, parentName: name, kind: 'implements' });
            }
          }
        }
      }
    }

    // --- Type-use extraction (TS + Python explicit annotations) ---
    // Attribute each referenced type to its enclosing symbol. Liberal capture
    // is safe: the impact query only surfaces types that are defined symbols,
    // so built-in captures (Promise, List, …) never reach a report unless the
    // workspace actually defines a symbol by that name. Stage 2 (tree-sitter)
    // replaces this with binding-accurate extraction behind the same edges.
    const isTs = ext === '.ts' || ext === '.tsx';
    if (isTs || lang === 'py') {
      const pushTypeUse = (typeName: string, role: ParsedTypeUse['role'], lineIdx: number): void => {
        // Strip generic/namespace qualifiers to the head name.
        const head = typeName.split(/[<.[]/, 1)[0];
        if (!head || !/^[A-Z]/.test(head) || BUILTIN_TYPE_NAMES.has(head)) return;
        typeUses.push({ userName: findScope(lineIdx), typeName: head, role, line: lineIdx + 1 });
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (
          trimmed.startsWith('import ') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('#')
        )
          continue;

        // Return type: `): Foo` (TS) or `-> Foo` (Python).
        const ret = line.match(/\)\s*:\s*([A-Za-z_$][\w$.<[\]]*)/) || line.match(/->\s*([A-Za-z_$][\w$.<[\]]*)/);
        if (ret) pushTypeUse(ret[1], 'return', i);

        // Variable declaration with a type annotation.
        const isVarDecl = /^\s*(?:export\s+)?(?:const|let|var|readonly)\s/.test(line);

        // Every `: Type` annotation on the line (params, fields, variables).
        TYPE_ANNOT_PATTERN.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TYPE_ANNOT_PATTERN.exec(line)) !== null) {
          // Skip the `):` return form already captured above.
          if (m.index > 0 && line[m.index - 1] === ')') continue;
          pushTypeUse(m[1], isVarDecl ? 'variable' : 'param', i);
        }
        // Generic type arguments: `Foo<Bar, Baz>`.
        GENERIC_ARG_PATTERN.lastIndex = 0;
        while ((m = GENERIC_ARG_PATTERN.exec(line)) !== null) {
          pushTypeUse(m[1], 'param', i);
        }
      }
    }

    return {
      filePath,
      elements,
      content,
      calls: calls.length > 0 ? calls : undefined,
      typeRelations: typeRelations.length > 0 ? typeRelations : undefined,
      typeUses: typeUses.length > 0 ? typeUses : undefined,
    };
  }

  /** Find relevant code elements based on query terms. */
  static findRelevantElements(parsedFile: ParsedFile, query: string): CodeElement[] {
    return findRelevantElements(parsedFile, query);
  }

  /** Extract relevant portions of a file based on identified elements. */
  static extractRelevantContent(parsedFile: ParsedFile, relevantElements: CodeElement[]): string {
    return extractRelevantContent(parsedFile, relevantElements);
  }
}
