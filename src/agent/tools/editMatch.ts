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
export type MatchTier = 'exact' | 'eol' | 'trailing-space' | 'indent' | 'blank-lines';

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
  /**
   * Set on an exact match whose replacement started at column 0 while the
   * code it replaces is indented: the replacement was re-based onto the
   * search's indentation (ML-41). Disclosed like a tolerance.
   */
  rebasedFromColumnZero?: boolean;
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

const leadingWhitespace = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** Columns an indentation string occupies, a tab counting as 4. Used only to order and scale levels. */
const indentWidth = (s: string): number => [...s].reduce((w, c) => w + (c === '\t' ? 4 : 1), 0);

/**
 * The search's indentation levels mapped onto the file's, from the lines the
 * match aligned. Null when the two disagree about nesting -- the same search
 * level at two file levels, two search levels at one, or a reversed order --
 * which means the search describes different structure than the file has,
 * and the match must not be used (ML-03: the indent tier ignored indentation
 * entirely and re-based by the first line's delta, so a `return` the search
 * placed inside an `else` was written there).
 */
function alignIndentLevels(searchLines: string[], fileLines: string[]): Map<string, string> | null {
  const map = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (let k = 0; k < searchLines.length && k < fileLines.length; k++) {
    if (searchLines[k].trim() === '' || fileLines[k].trim() === '') continue;
    const s = leadingWhitespace(searchLines[k]);
    const f = leadingWhitespace(fileLines[k]);
    if ((map.has(s) && map.get(s) !== f) || (reverse.has(f) && reverse.get(f) !== s)) return null;
    map.set(s, f);
    reverse.set(f, s);
  }
  const pairs = [...map].sort((a, b) => indentWidth(a[0]) - indentWidth(b[0]));
  for (let i = 1; i < pairs.length; i++) {
    if (indentWidth(pairs[i][1]) <= indentWidth(pairs[i - 1][1])) return null;
  }
  return map;
}

/** The file's indentation unit: a tab, or the most common positive step between consecutive lines. */
function fileIndentUnit(text: string, eol: string): string {
  const lines = text.split(eol).filter((l) => l.trim() !== '');
  if (lines.some((l) => l.startsWith('\t'))) return '\t';
  const steps = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const d = leadingWhitespace(lines[i]).length - leadingWhitespace(lines[i - 1]).length;
    if (d > 0) steps.set(d, (steps.get(d) ?? 0) + 1);
  }
  const best = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return ' '.repeat(best?.[0] ?? 4);
}

/**
 * Re-indent `replacement` line by line through the aligned levels: a line at a
 * search level gets that level's file indentation; a level the search did not
 * use is placed by counting indentation units from the nearest aligned level.
 * Relative nesting survives a 2-space search on a 4-space file, a tab search on
 * a space file, and a search whose first line is not its shallowest (ML-22).
 * Blank lines are left alone so re-indenting never adds trailing whitespace.
 */
function reindentByLevels(
  replacement: string,
  levels: Map<string, string>,
  searchLines: string[],
  text: string,
  eol: string,
): string {
  if ([...levels].every(([s, f]) => s === f)) return replacement;
  const known = [...levels].sort((a, b) => indentWidth(a[0]) - indentWidth(b[0]));
  if (known.length === 0) return replacement;
  const fileUnit = fileIndentUnit(text, eol);
  const widths = [
    ...new Set(
      [...searchLines, ...replacement.split(eol)]
        .filter((l) => l.trim() !== '')
        .map((l) => indentWidth(leadingWhitespace(l))),
    ),
  ].sort((a, b) => a - b);
  let searchUnit = 0;
  for (let i = 1; i < widths.length; i++) {
    const d = widths[i] - widths[i - 1];
    if (d > 0 && (searchUnit === 0 || d < searchUnit)) searchUnit = d;
  }
  if (searchUnit === 0) searchUnit = indentWidth(fileUnit);
  return replacement
    .split(eol)
    .map((line) => {
      if (line.trim() === '') return line;
      const own = leadingWhitespace(line);
      const body = line.slice(own.length);
      const exact = levels.get(own);
      if (exact !== undefined) return exact + body;
      const w = indentWidth(own);
      const below = [...known].reverse().find(([s]) => indentWidth(s) <= w);
      if (below) {
        const units = Math.round((w - indentWidth(below[0])) / searchUnit);
        return below[1] + fileUnit.repeat(Math.max(0, units)) + body;
      }
      const [lowS, lowF] = known[0];
      let indent = lowF;
      for (let u = Math.round((indentWidth(lowS) - w) / searchUnit); u > 0; u--) {
        indent = indent.endsWith(fileUnit) ? indent.slice(0, -fileUnit.length) : '';
      }
      return indent + body;
    })
    .join(eol);
}

/** Prefix every non-blank line with `indent`. */
const indentAll = (s: string, indent: string, eol: string): string =>
  s
    .split(eol)
    .map((l) => (l.trim() === '' ? l : indent + l))
    .join(eol);

/**
 * Locate `search` in `text`, absorbing as little whitespace difference as
 * possible, and return the byte span it occupies together with `replace`
 * adapted to the file. Returns null when no tier matches — the caller then
 * falls through to the intent-based fuzzy recovery.
 */
export function findEditMatch(
  text: string,
  search: string,
  replace: string,
  options: MatchOptions = {},
): EditMatch | null {
  return findEditMatches(text, search, replace, options)[0] ?? null;
}

/**
 * Every non-overlapping occurrence of `search` at the first tier that matches,
 * in file order, each with its own span and its own adapted replacement (on
 * the `indent` tier every occurrence is re-indented to ITS indentation).
 * `count` on each is the total. Empty when no tier matches.
 *
 * replace_all needs all of them: splitting on the first match's exact bytes
 * left any occurrence the tier had matched with different whitespace
 * untouched, while the summary still counted it as replaced.
 */
export interface MatchOptions {
  /**
   * Re-base an exact match's column-0 replacement onto the search's
   * indentation (ML-41). Only where indentation is syntax -- Python -- is a
   * column-0 replacement of indented code almost always a mistake; in YAML,
   * Markdown or text it is often the intent.
   */
  rebaseColumnZero?: boolean;
}

export function findEditMatches(
  text: string,
  search: string,
  replace: string,
  options: MatchOptions = {},
): EditMatch[] {
  if (search === '') return [];
  const { eol } = detectEol(text);
  const adapted = applyEol(replace, eol);

  /**
   * Absorb the `\r` the span begins just after. A search starting with `\n`
   * matches the second half of a `\r\n` pair, so the span opens between the
   * two; replacing from there left the file's `\r` stranded (as `\r\r\n` in
   * front of a replacement that starts with a line break, or as a lone `\r`
   * in front of one that does not). The `\r` belongs to the line break the
   * search is replacing, so it goes with it.
   */
  const absorbSplitCrlf = (start: number): number =>
    start > 0 && text[start] === '\n' && text[start - 1] === '\r' ? start - 1 : start;

  /**
   * The same at the end (ML-27): a span ending between `\r` and `\n` -- a
   * search ending in a lone `\r` -- left the `\n` behind as a bare LF. The
   * file's line break stays whole: the `\r` leaves the span, and the line
   * break the replacement gained from its own trailing `\r` is dropped.
   */
  const splitCrlfAtEnd = (end: number): boolean => end > 0 && text[end - 1] === '\r' && text[end] === '\n';
  const withoutTrailingBreak = (r: string): string => (r.endsWith(eol) ? r.slice(0, -eol.length) : r);

  /**
   * Every occurrence, overlapping ones included (ML-28). Stepping past each
   * match counted `x\nm\nx` once in `x\nm\nx\nm\nx`, and the "unique" search
   * was applied to the first. The spans returned stay non-overlapping, so a
   * count above their number means the occurrences overlap.
   */
  const countOverlapping = (hay: string, needle: string): number => {
    let n = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n++;
    return n;
  };

  // ML-41: an exact match whose replacement starts at column 0 while the code
  // it replaces is indented moved that code out of its block (`if not data:`
  // left `load()` and ran at import time; a `return` became module-level).
  // Re-base the replacement onto the search's indentation, keeping its own
  // relative nesting.
  const searchIndent = leadingWhitespace(search);
  const replLines = adapted.split(eol).filter((l) => l.trim() !== '');
  const rebaseFromZero =
    options.rebaseColumnZero === true && searchIndent !== '' && replLines.some((l) => leadingWhitespace(l) === '');

  const exact: EditMatch[] = [];
  for (let from = 0; ; ) {
    const at = text.indexOf(search, from);
    if (at === -1) break;
    let end = at + search.length;
    let replacement = adapted;
    if (splitCrlfAtEnd(end)) {
      end--;
      replacement = withoutTrailingBreak(replacement);
    }
    const atLineStart = at === 0 || text[at - 1] === '\n';
    const rebase = rebaseFromZero && atLineStart;
    if (rebase) replacement = indentAll(replacement, searchIndent, eol);
    exact.push({
      start: absorbSplitCrlf(at),
      end,
      count: 0,
      tier: 'exact',
      replacement,
      ...(rebase ? { rebasedFromColumnZero: true } : {}),
    });
    from = at + search.length;
  }
  if (exact.length > 0) {
    const count = Math.max(exact.length, countOverlapping(text, search));
    return exact.map((m) => ({ ...m, count }));
  }

  const searchLines = applyEol(search, '\n').split('\n');
  // ML-25: a search that ends with the NEXT line's indentation (`foo\n    `)
  // had that indentation dropped as "trailing" whitespace on the lax tiers,
  // while the replacement kept it, so the next line's indent was doubled.
  const endsWithNextIndent = /\n[ \t]+$/.test(applyEol(search, '\n'));

  for (const tier of ['eol', 'trailing-space', 'indent'] as const) {
    const { canon, map } = canonicalize(text, tier);
    const canonSearch = canonicalize(search, tier).canon;
    if (canonSearch === '') continue;
    const found: EditMatch[] = [];
    let occurrences = 0;
    for (let at = canon.indexOf(canonSearch); at !== -1; at = canon.indexOf(canonSearch, at + 1)) occurrences++;
    for (let from = 0; ; ) {
      const ci = canon.indexOf(canonSearch, from);
      if (ci === -1) break;
      from = ci + canonSearch.length;
      let start = map[ci];
      let end = map[ci + canonSearch.length - 1] + 1;
      // A slice handed in by a `within` locator starts at a line start (fs.ts
      // slices there), so offset 0 is a real one.
      const startsAtLine = ci === 0 || canon[ci - 1] === '\n';
      const endsWithBreak = canonSearch.endsWith('\n');
      const endsAtLine =
        !endsWithBreak && (ci + canonSearch.length === canon.length || canon[ci + canonSearch.length] === '\n');

      // The indent tier exists for whole lines whose indentation differs. A
      // match that starts mid-line spliced the model's indentation into the
      // middle of a line (ML-68: `self.            n_components = ...`). A
      // search that starts with a line break begins at a line boundary too.
      if (tier === 'indent' && !startsAtLine && !canonSearch.startsWith('\n')) continue;

      // The tier ignored characters at the edges of the match; pull them back
      // into the span so they are replaced rather than left stranded beside the
      // new text (a `bar   ` where the file had `foo   `, or the old indentation
      // in front of a re-indented block). Not past a line break the search
      // ended with: that pulled in the next, whitespace-only line (ML-26).
      if (endsAtLine) {
        while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
      }
      if (endsWithBreak && endsWithNextIndent) {
        while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
      }
      if (tier === 'indent' && startsAtLine) {
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
      }
      start = absorbSplitCrlf(start);

      let replacement = adapted;
      if (tier === 'indent') {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const fileLines = applyEol(text.slice(lineStart), '\n').split('\n').slice(0, searchLines.length);
        const levels = alignIndentLevels(searchLines, fileLines);
        if (levels === null) continue; // the search's nesting contradicts the file's
        replacement = reindentByLevels(adapted, levels, searchLines, text, eol);
      }
      found.push({ start, end, count: 0, tier, replacement });
    }
    if (found.length > 0) {
      const count = Math.max(found.length, occurrences);
      return found.map((m) => ({ ...m, count }));
    }
  }

  return findBlankTolerantMatches(text, search, replace, eol);
}

const isBlank = (line: string): boolean => line.trim() === '';
const trimEnd = (line: string): string => line.replace(/[ \t]+$/, '');

interface FileLine {
  text: string;
  start: number;
  /** End of the line's content, before its line break. */
  contentEnd: number;
  /** After its line break (= contentEnd on a last line without one). */
  end: number;
}

function splitLines(text: string): FileLine[] {
  const lines: FileLine[] = [];
  const re = /\r\n|\r|\n/g;
  let start = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    lines.push({ text: text.slice(start, m.index), start, contentEnd: m.index, end: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), start, contentEnd: text.length, end: text.length });
  return lines;
}

/** For each line of `a`, the index of the line of `b` a longest common subsequence aligns it with, or -1. */
function alignLines(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = trimEnd(a[i]) === trimEnd(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (trimEnd(a[i]) === trimEnd(b[j])) out[i++] = j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * The last tier (#155 ML-37): the search's lines are all in the file, in
 * order, and differ from it only in blank (or whitespace-only) lines -- most
 * often a blank line the model left out. Whole lines only: the search's first
 * and last lines must be non-blank, it must have at least two non-blank lines,
 * and each must equal a file line up to trailing whitespace. As on every tier,
 * more than one occurrence is reported as ambiguous, never picked from.
 *
 * The file's blank lines are kept. Where the replacement still has the gap the
 * search had between two of its lines, the blank lines that end that gap are
 * swapped for the ones the file really has -- so editing the lines around a
 * gap, or inserting code into it, does not quietly delete it. Where the
 * replacement changed the number of blank lines there, or the gap's place in
 * the replacement is unknown, the replacement is written as sent.
 */
function findBlankTolerantMatches(text: string, search: string, replace: string, eol: string): EditMatch[] {
  const searchLf = applyEol(search, '\n');
  const endsWithBreak = searchLf.endsWith('\n');
  const sLines = (endsWithBreak ? searchLf.slice(0, -1) : searchLf).split('\n');
  const content = sLines.map((l, i) => (isBlank(l) ? -1 : i)).filter((i) => i >= 0);
  if (content.length < 2 || isBlank(sLines[0]) || isBlank(sLines[sLines.length - 1])) return [];
  const replaceLf = applyEol(replace, '\n');
  const replaceEndsWithBreak = replaceLf.endsWith('\n');
  const rLines = (replaceEndsWithBreak ? replaceLf.slice(0, -1) : replaceLf).split('\n');
  // The alignment is quadratic; a search or replacement this large is not the
  // dropped-blank-line case this tier exists for.
  if (sLines.length * rLines.length > 250_000) return [];

  const lines = splitLines(text);
  /** File line index of each non-blank search line, starting at file line `i`, or null. */
  const matchAt = (i: number): number[] | null => {
    const at: number[] = [];
    let j = i;
    for (const k of content) {
      if (at.length > 0) while (j < lines.length && isBlank(lines[j].text)) j++;
      if (j >= lines.length || trimEnd(lines[j].text) !== trimEnd(sLines[k])) return null;
      at.push(j++);
    }
    return at;
  };

  const hits: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const at = matchAt(i);
    if (at) hits.push(at);
  }
  if (hits.length === 0) return [];

  // Where each search line sits in the replacement, seen from the gap after it
  // (posL) and the gap before it (posR). A line the replacement kept is at its
  // own line. A changed block that swaps lines one for one maps line by line.
  // In any other changed block only its edges are known: its last line ends
  // where the block's replacement ends, its first starts where it starts.
  // Lines inside such a block have no position, so no gap there is touched.
  const toReplace = alignLines(sLines, rLines);
  const posL = new Array<number | null>(sLines.length).fill(null);
  const posR = new Array<number | null>(sLines.length).fill(null);
  let i1 = -1;
  let j1 = -1;
  const closeBlock = (i2: number, j2: number): void => {
    const oneForOne = i2 - i1 === j2 - j1;
    for (let i = i1 + 1; i < i2; i++) {
      if (oneForOne) posL[i] = posR[i] = j1 + (i - i1);
      else {
        if (i === i2 - 1) posL[i] = j2 - 1;
        if (i === i1 + 1) posR[i] = j1 + 1;
      }
    }
  };
  for (let i = 0; i < sLines.length; i++) {
    if (toReplace[i] < 0) continue;
    closeBlock(i, toReplace[i]);
    posL[i] = posR[i] = toReplace[i];
    i1 = i;
    j1 = toReplace[i];
  }
  closeBlock(sLines.length, rLines.length);

  const found: EditMatch[] = [];
  let next = 0;
  for (const at of hits) {
    if (at[0] < next) continue; // overlaps the previous span: counted, not returned
    next = at[at.length - 1] + 1;
    const out = [...rLines];
    // Right to left, so the indices of earlier gaps stay valid as later ones change size.
    for (let g = content.length - 2; g >= 0; g--) {
      const fileBlanks = lines.slice(at[g] + 1, at[g + 1]).map((l) => l.text);
      const searchBlanks = content[g + 1] - content[g] - 1;
      if (fileBlanks.length === searchBlanks) continue;
      const p = posL[content[g]];
      const q = posR[content[g + 1]];
      if (p === null || q === null || q <= p) continue;
      // The blank lines that end the gap in the replacement. When there are as
      // many as the search had there, the model did not mean to change them:
      // they become the file's. Code the model inserted into the gap stays,
      // ahead of them (a method added between two methods keeps the blank line
      // before the next one).
      let trail = 0;
      while (trail < q - p - 1 && isBlank(out[q - 1 - trail])) trail++;
      if (trail !== searchBlanks) continue;
      out.splice(q - trail, trail, ...fileBlanks);
    }
    const last = lines[at[at.length - 1]];
    found.push({
      start: lines[at[0]].start,
      end: endsWithBreak ? last.end : last.contentEnd,
      count: 0,
      tier: 'blank-lines',
      replacement: applyEol(out.join('\n') + (replaceEndsWithBreak ? '\n' : ''), eol),
    });
  }
  return found.map((m) => ({ ...m, count: hits.length }));
}

/**
 * The disclosure for a tolerant match, or '' for an exact one. The model is
 * told what differed so its next search string can be right the first time —
 * silently absorbing the difference would teach it nothing.
 */
export function matchToleranceNote(match: EditMatch, filePath: string, text: string): string {
  if (match.rebasedFromColumnZero) {
    return (
      `[note: your replacement started at column 0, but the code it replaces in ${filePath} is indented. It was ` +
      `indented to match, keeping its own nesting, so it stays inside its block. Verify the result.]\n`
    );
  }
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
    case 'blank-lines':
      return (
        `[note: your search's blank lines did not match ${filePath} (a blank line left out or added). It was ` +
        `matched ignoring blank lines, and the file's own blank lines were kept between the lines your ` +
        `replacement left unchanged. Verify the result.]\n`
      );
  }
}
