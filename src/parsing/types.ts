/**
 * Language-agnostic code analyzer interface.
 * Both regex (SimpleCodeAnalyzer) and tree-sitter implementations conform to this.
 */

import type { CodeElement, ParsedFile } from '../astContext.js';

export type { CodeElement, ParsedFile };

export interface CodeAnalyzer {
  /** Languages this analyzer can handle (file extensions without leading dot). */
  readonly supportedExtensions: ReadonlySet<string>;

  /** Parse a file and extract code elements. */
  parseFileContent(filePath: string, content: string): ParsedFile;

  /** Find elements relevant to a query. */
  findRelevantElements(parsedFile: ParsedFile, query: string): CodeElement[];

  /** Extract relevant content from a parsed file given selected elements. */
  extractRelevantContent(parsedFile: ParsedFile, relevantElements: CodeElement[]): string;
}
