import { describe, it, expect } from 'vitest';
import type { CodeAnalyzer, ParsedFile, CodeElement } from './types.js';

describe('CodeAnalyzer interface', () => {
  it('can be implemented with the expected shape', () => {
    const analyzer: CodeAnalyzer = {
      supportedExtensions: new Set(['ts', 'js']),
      parseFileContent: (filePath: string, content: string): ParsedFile => ({
        filePath,
        elements: [],
        content,
      }),
      findRelevantElements: (_parsedFile: ParsedFile, _query: string): CodeElement[] => [],
      extractRelevantContent: (_parsedFile: ParsedFile, _elements: CodeElement[]) => '',
    };
    expect(analyzer.supportedExtensions.has('ts')).toBe(true);
    expect(analyzer.parseFileContent('test.ts', 'code').filePath).toBe('test.ts');
    expect(analyzer.findRelevantElements({} as ParsedFile, 'query')).toEqual([]);
  });
});
