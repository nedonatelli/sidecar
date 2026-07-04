/**
 * Text tokenization for workspace relevance scoring: lowercases and splits on
 * camelCase / snake_case / kebab-case / path separators / punctuation, dropping
 * stop words and one-character tokens. Pure — shared by the query and path
 * scoring paths in WorkspaceIndex.
 */

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'how',
  'what',
  'why',
  'when',
  'where',
  'do',
  'does',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'it',
  'we',
  'they',
]);

const CAMEL_SPLIT_RE = /([a-z])([A-Z])/g;
const NON_ALNUM_RE = /[^a-z0-9]+/;

/** Split text into lowercased tokens, splitting on camelCase, snake_case, kebab-case, paths, and punctuation. */
export function tokenize(text: string): string[] {
  return text
    .replace(CAMEL_SPLIT_RE, '$1 $2')
    .toLowerCase()
    .split(NON_ALNUM_RE)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}
