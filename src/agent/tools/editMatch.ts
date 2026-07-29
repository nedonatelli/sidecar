// Whitespace- and line-ending-tolerant matching for edit_file.
//
// edit_file's contract is byte-exact: `search` must appear in the file
// verbatim. That is the right default — it is what makes the uniqueness and
// token-boundary guards meaningful — but taken alone it fails an entire class
// of edits for reasons that have nothing to do with the model being wrong:
//
//   • CRLF. A model emits LF. On a CRLF file every MULTI-LINE search misses,
//     because the file holds `a\r\nb` and the search holds `a\nb`. The error
//     said "search string not found", which is true and useless — the text IS
//     there. Single-line searches worked, so the failure looked random.
//   • Trailing whitespace. `read_file(mode='compact')` right-trims every line,
//     so text copied out of a compact read cannot match the file it came from.
//   • Indentation. A model retyping a block from memory reproduces the code and
//     loses the leading indentation, or produces 2-space where the file has 4.
//
// Each tier below resolves to a REAL byte span in the original text, so the
// caller splices with `text.slice()` and every downstream guard still runs
// against real file bytes. Tolerance only ever converts a hard failure into a
// disclosed success — an exact match is always preferred, and a tier that finds
// more than one match reports the ambiguity rather than picking one.

/** How much whitespace difference a match had to absorb. `exact` = none. */
export type MatchTier = 'exact' | 'eol' | 'trailing-space' | 'indent';

export interface EditMatch {
  /** Byte offset of the match in the ORIGINAL text. */
  start: number;
  /** Exclusive end offset in the ORIGINAL text. */
  end: number;
  /** Occurrences at the winning tier. > 1 means the caller must refuse as ambiguous. */
  count: number;
  tier: MatchTier;
  /**
   * `replace`, adapted to the file: line endings converted to the file's
   * dominant convention, and (on the `indent` tier) re-indented to the matched
   * region's indentation.
   */
  replacement: string;
}

export interface EolInfo {
  /** The file's dominant line ending. `\n` when the text has no line breaks. */
  eol: '\n' | '\r\n' | '\r';
  /** False when the text mixes conventions — then `eol` is merely the most common. */
  uniform: boolean;
}

export function detectEol(text: string): EolInfo {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const kinds = [crlf, cr, lf].filter((n) => n > 0).length;
  if (crlf === 0 && cr === 0) return { eol: '\n', uniform: kinds <= 1 };
  if (crlf >= cr && crlf >= lf) return { eol: '\r\n', uniform: kinds <= 1 };
  if (cr >= lf) return { eol: '\r', uniform: kinds <= 1 };
  return { eol: '\n', uniform: kinds <= 1 };
}

/** Rewrite every line ending in `text` to `eol`, whatever it currently uses. */
export function applyEol(text: string, eol: string): string {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

/**
 * A canonical form of `text` for one tolerance tier, plus a map from each
 * canonical character back to its offset in the original. The map is what lets
 * a tolerant match still name an exact byte span: characters the tier ignores
 * (a `\r`, a run of trailing spaces, a line's indentation) are dropped from the
 * canonical string and simply have no entry.
 */
function canonicalize(text: string, tier: MatchTier): { canon: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let atLineStart = true;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\r') {
      // CRLF: drop the \r and let the \n be emitted next pass. Lone CR (classic
      // Mac): emit as \n so it compares equal to an LF search.
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      out.push('\n');
      map.push(i);
      atLineStart = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      out.push('\n');
      map.push(i);
      atLineStart = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (tier === 'indent' && atLineStart) {
        i++;
        continue;
      }
      if (tier !== 'eol') {
        // Trailing run: whitespace with nothing but a line break (or EOF) after it.
        let j = i;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
        const next = text[j];
        if (next === undefined || next === '\n' || next === '\r') {
          i = j;
          continue;
        }
      }
    }
    out.push(ch);
    map.push(i);
    atLineStart = false;
    i++;
  }
  return { canon: out.join(''), map };
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

const leadingWhitespace = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/**
 * Shift `replacement` from the search's indentation to the file's. Lines
 * carrying the search's leading indentation are re-based onto the file's, which
 * preserves relative nesting: a body line indented one level deeper than the
 * anchor stays one level deeper. Blank lines are left alone so re-indenting
 * never introduces trailing whitespace.
 */
function reindent(replacement: string, searchIndent: string, fileIndent: string, eol: string): string {
  if (searchIndent === fileIndent) return replacement;
  return replacement
    .split(eol)
    .map((line) => {
      if (line.trim() === '') return line;
      return line.startsWith(searchIndent) ? fileIndent + line.slice(searchIndent.length) : line;
    })
    .join(eol);
}

/**
 * Locate `search` in `text`, absorbing as little whitespace difference as
 * possible, and return the byte span it occupies together with `replace`
 * adapted to the file. Returns null when no tier matches — the caller then
 * falls through to the intent-based fuzzy recovery.
 */
export function findEditMatch(text: string, search: string, replace: string): EditMatch | null {
  if (search === '') return null;
  const { eol } = detectEol(text);
  const adapted = applyEol(replace, eol);

  const exactCount = countOccurrences(text, search);
  if (exactCount > 0) {
    const start = text.indexOf(search);
    return { start, end: start + search.length, count: exactCount, tier: 'exact', replacement: adapted };
  }

  for (const tier of ['eol', 'trailing-space', 'indent'] as const) {
    const { canon, map } = canonicalize(text, tier);
    const canonSearch = canonicalize(search, tier).canon;
    if (canonSearch === '') continue;
    const count = countOccurrences(canon, canonSearch);
    if (count === 0) continue;

    const ci = canon.indexOf(canonSearch);
    let start = map[ci];
    let end = map[ci + canonSearch.length - 1] + 1;
    const startsAtLine = ci === 0 || canon[ci - 1] === '\n';
    const endsAtLine = ci + canonSearch.length === canon.length || canon[ci + canonSearch.length] === '\n';

    // The tier ignored characters at the edges of the match; pull them back
    // into the span so they are replaced rather than left stranded beside the
    // new text (a `bar   ` where the file had `foo   `, or the old indentation
    // in front of a re-indented block).
    if (endsAtLine) {
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    }
    if (tier === 'indent' && startsAtLine) {
      while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    }

    let replacement = adapted;
    if (tier === 'indent' && startsAtLine) {
      const fileIndent = leadingWhitespace(text.slice(start));
      const searchIndent = leadingWhitespace(search);
      replacement = reindent(adapted, searchIndent, fileIndent, eol);
    }
    return { start, end, count, tier, replacement };
  }

  return null;
}

/**
 * The disclosure for a tolerant match, or '' for an exact one. The model is
 * told what differed so its next search string can be right the first time —
 * silently absorbing the difference would teach it nothing.
 */
export function matchToleranceNote(match: EditMatch, filePath: string, text: string): string {
  if (match.tier === 'exact') return '';
  const name = (e: string) => (e === '\r\n' ? 'CRLF' : e === '\r' ? 'CR' : 'LF');
  switch (match.tier) {
    case 'eol':
      return (
        `[note: your search used ${name(detectEol(match.replacement).eol)} line endings and ${filePath} uses ` +
        `${name(detectEol(text).eol)}. It was matched on content, and the replacement was written with the file's ` +
        `line endings.]\n`
      );
    case 'trailing-space':
      return (
        `[note: your search differed from ${filePath} in trailing whitespace only. It was matched on content; ` +
        `copy from read_file (not the 'compact' view, which right-trims) to match byte-for-byte.]\n`
      );
    case 'indent':
      return (
        `[note: your search's indentation did not match ${filePath}. It was matched on content and your ` +
        `replacement was re-indented to the file's indentation. Verify the result.]\n`
      );
  }
}
