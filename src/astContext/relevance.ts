/**
 * Query-relevance scoring + snippet extraction over a ParsedFile. Pure
 * functions consumed by SimpleCodeAnalyzer; kept separate from the parser so
 * the retrieval heuristics can evolve independently.
 */

import type { CodeElement, ParsedFile } from '../astContext.js';

/** Find relevant code elements based on query terms. */
export function findRelevantElements(parsedFile: ParsedFile, query: string): CodeElement[] {
  const relevantElements: CodeElement[] = [];
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);

  for (const element of parsedFile.elements) {
    let score = 0;

    // Check if element name matches query terms
    for (const term of queryTerms) {
      if (element.name.toLowerCase().includes(term)) {
        score += 0.5;
      }
    }

    // Check if element content matches query terms
    for (const term of queryTerms) {
      if (element.content.toLowerCase().includes(term)) {
        score += 0.3;
      }
    }

    // Boost based on element type
    if (element.type === 'function' || element.type === 'method') {
      score += 0.2;
    } else if (element.type === 'class') {
      score += 0.3;
    }

    if (score > 0.3) {
      relevantElements.push({ ...element, relevanceScore: score });
    }
  }

  // Sort by relevance score
  relevantElements.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return relevantElements;
}

/** Extract relevant portions of a file based on identified elements. */
export function extractRelevantContent(parsedFile: ParsedFile, relevantElements: CodeElement[]): string {
  if (relevantElements.length === 0) {
    const lines = parsedFile.content.split('\n');
    return lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n...' : '');
  }

  const lines = parsedFile.content.split('\n');
  const relevantLines = new Set<number>();

  for (const element of relevantElements) {
    // Include 1 line of context before the element and the full body
    const start = Math.max(0, element.startLine - 1);
    const end = Math.min(element.endLine + 1, lines.length - 1);
    for (let i = start; i <= end; i++) {
      relevantLines.add(i);
    }
  }

  // Build output with `...` markers for skipped regions
  const sorted = Array.from(relevantLines).sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -2; // sentinel so first region doesn't get a gap marker

  for (const lineIdx of sorted) {
    if (lineIdx > prev + 1) {
      parts.push('...');
    }
    parts.push(lines[lineIdx]);
    prev = lineIdx;
  }

  // Trailing indicator if we didn't reach the end
  if (sorted[sorted.length - 1] < lines.length - 1) {
    parts.push('...');
  }

  return parts.join('\n');
}
