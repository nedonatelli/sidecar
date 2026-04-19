// ---------------------------------------------------------------------------
// SIDECAR.md parser + path-scoped section selector (v0.67 chunk 1).
//
// The pre-v0.67 injection path at systemPrompt.ts dumped the entire
// SIDECAR.md body into every turn's system prompt and mid-chopped on
// overflow — a 15 KB doc burned ~3.7 KB of every turn on a 4K local
// Llama regardless of relevance, with half-sentences at the truncation
// boundary leaving the model staring at incomplete rules.
//
// This module replaces that with a deterministic, path-aware selector.
// Sections opt-in to scoping via an HTML-comment sentinel immediately
// under the H2 heading:
//
//     ## Transforms
//     <!-- @paths: src/transforms/**, src/dsp/** -->
//     Filter kernels go under src/transforms/...
//
// The HTML-comment form is invisible in GitHub's markdown preview and
// other standard renderers, so the file still reads cleanly for humans.
//
// Sections without a sentinel default to priority: 'always', which
// preserves pre-v0.67 behavior for unannotated files — no user
// migration required.
//
// The parser is a pure primitive (no VS Code imports) so it's trivial
// to test and reusable by the future retrieval-mode successor
// (v0.70+) that embeds chunks for semantic scoring.
// ---------------------------------------------------------------------------

export type SectionPriority = 'always' | 'scoped' | 'low';

export interface SidecarMdSection {
  /** The H2 heading text, without the leading `## `. */
  readonly heading: string;
  /**
   * Full section body including the `## ` heading line. Preserved
   * verbatim so injected sections render with their headings intact
   * (the model gets "## Build\n- Run `npm test`" not just the body).
   */
  readonly body: string;
  /**
   * Path globs declared in a `<!-- @paths: glob, glob -->` sentinel
   * immediately below the heading. Empty array when no sentinel was
   * present. Globs support `**` (any depth) and `*` (any segment chars
   * except `/`); everything else matches literally.
   */
  readonly paths: readonly string[];
  /**
   * Resolved by the parser only when a sentinel is present
   * (`'scoped'`) or absent (`'always'`). The selector may further
   * downgrade an `'always'` section to `'low'` when its heading
   * matches the caller's `lowPriorityHeadings` list — parser state
   * is the input, selector state is the decision.
   */
  readonly priority: SectionPriority;
}

export interface ParsedSidecarMd {
  /**
   * Content before the first H2 heading (typically the file's H1
   * title + any top-of-file notes). Always included verbatim by the
   * selector — it's the file's framing.
   */
  readonly preamble: string;
  readonly sections: readonly SidecarMdSection[];
  /**
   * `true` iff at least one section had an `@paths` sentinel. The
   * selector uses this to decide whether `sections` mode is
   * meaningful for this file — a file with zero sentinels collapses
   * back to whole-file behavior regardless of the user's
   * `sidecarMdMode` setting.
   */
  readonly hasAnyPathSentinel: boolean;
}

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;
const PATHS_SENTINEL_RE = /^\s*<!--\s*@paths:\s*([^-]+?)\s*-->\s*$/;

/**
 * Parse a SIDECAR.md body into a preamble + H2-bounded sections.
 *
 * Treats `##` and `###` as the section boundary — the doc's H1 is
 * typically the file title (`# Project: Foo`) and lives in the
 * preamble, not as its own section. H3s are treated as section
 * boundaries too so users can opt into finer-grained path scoping
 * without restructuring the doc; H4+ are left in the body of their
 * containing H2/H3.
 */
export function parseSidecarMd(content: string): ParsedSidecarMd {
  const lines = content.split(/\r?\n/);
  const sections: SidecarMdSection[] = [];
  let hasAnyPathSentinel = false;

  // Walk once, collecting lines into the current section (or the
  // preamble, before any heading has appeared).
  const preambleLines: string[] = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  let currentPaths: string[] = [];

  const flushCurrent = () => {
    if (currentHeading === null) return;
    const bodyText = currentBody.join('\n').replace(/\s+$/, '');
    sections.push({
      heading: currentHeading,
      body: bodyText,
      paths: currentPaths,
      priority: currentPaths.length > 0 ? 'scoped' : 'always',
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(HEADING_RE);

    if (headingMatch) {
      // Starting a new section; flush the in-progress one first.
      flushCurrent();
      currentHeading = headingMatch[2];
      currentBody = [line];
      currentPaths = [];

      // The `@paths` sentinel (if present) must live on the very
      // next non-blank line after the heading. We peek forward to
      // find it without consuming the line yet — the outer loop
      // handles the increment.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length) {
        const sentinelMatch = lines[j].match(PATHS_SENTINEL_RE);
        if (sentinelMatch) {
          currentPaths = sentinelMatch[1]
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
          if (currentPaths.length > 0) hasAnyPathSentinel = true;
        }
      }
      continue;
    }

    if (currentHeading === null) {
      preambleLines.push(line);
    } else {
      currentBody.push(line);
    }
  }

  flushCurrent();

  const preamble = preambleLines.join('\n').replace(/\s+$/, '');
  return { preamble, sections, hasAnyPathSentinel };
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a regex. Supports:
 *   - `**`  → any path depth (including `/`)
 *   - `*`   → any run of non-`/` characters
 *   - `?`   → any single non-`/` character
 *   - All regex metacharacters (`.`, `+`, `(`, etc.) escape literally.
 *
 * Leading `/` and leading `./` are stripped so both absolute and
 * relative globs work. Trailing `/` is treated as `/**` so a pattern
 * like `src/transforms/` matches everything inside.
 */
function globToRegex(glob: string): RegExp {
  let pattern = glob.trim();
  // Strip leading ./ and /, which users often include for readability.
  pattern = pattern.replace(/^\.?\//, '');
  // Trailing slash: include everything inside.
  if (pattern.endsWith('/')) pattern += '**';

  // Escape regex metacharacters EXCEPT `*` and `?` which we substitute
  // next. The order matters — escape first, then rewrite.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace `**` first (two-char token) then `*` and `?`.
  const re = escaped
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DOUBLESTAR__/g, '.*');

  return new RegExp(`^${re}$`);
}

/**
 * Test whether `filePath` matches any of the `globs`. Paths are
 * normalized to forward-slash form first so Windows paths with `\`
 * still work. Returns false for empty glob arrays.
 */
export function pathMatchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');
  for (const glob of globs) {
    if (globToRegex(glob).test(normalized)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

export interface SelectSectionsContext {
  /**
   * Relative path of the editor's active document, if any. Used to
   * resolve `@paths` sentinels to matching sections.
   */
  readonly activeFilePath?: string;
  /**
   * Paths the user explicitly mentioned in their message (via
   * `@file:path` sentinels or backtick-quoted paths). Gives the
   * selector something to match when no editor is active.
   */
  readonly mentionedPaths?: readonly string[];
  /**
   * Section headings that always get `priority: 'always'` regardless
   * of whether they declare a sentinel. Useful for teams who don't
   * want to edit their SIDECAR.md — "always include the `Build`
   * section" lives in user settings, not in the doc.
   *
   * Matched case-insensitively against `section.heading`.
   */
  readonly alwaysIncludeHeadings?: readonly string[];
  /**
   * Section headings that get demoted to `priority: 'low'` — included
   * only when budget remains after everything else. Matched
   * case-insensitively.
   */
  readonly lowPriorityHeadings?: readonly string[];
  /**
   * Cap on how many `scoped` sections can land in one injection.
   * Guards against a wildcard-ish path glob that matches 30 sections.
   */
  readonly maxScopedSections?: number;
  /**
   * Hard cap on total rendered chars (preamble + selected section
   * bodies + separators). Whole sections drop in reverse priority
   * order until the result fits; nothing is mid-chopped.
   */
  readonly maxChars: number;
}

export interface SectionSelection {
  /**
   * The rendered string ready to inject into the system prompt.
   * Empty when `sections.length === 0` and `preamble` is empty.
   */
  readonly rendered: string;
  /**
   * The sections the selector actually chose, in injection order
   * (always → scoped → low). Exposed for telemetry / verbose-log
   * surfacing so the user can see *why* a section did or didn't
   * appear.
   */
  readonly sections: readonly SidecarMdSection[];
  /**
   * Sections excluded because of budget pressure or
   * `maxScopedSections` cap. Populated for verbose-log
   * introspection; empty on the happy path.
   */
  readonly droppedForBudget: readonly SidecarMdSection[];
}

/**
 * Render a preamble + selected section list into a single string with
 * blank-line separators. Preserves section bodies verbatim (heading
 * line included) so the model sees fully-formed markdown.
 */
function renderSelection(preamble: string, sections: readonly SidecarMdSection[]): string {
  const chunks: string[] = [];
  if (preamble.trim().length > 0) chunks.push(preamble);
  for (const s of sections) chunks.push(s.body);
  return chunks.join('\n\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Apply priority rules to a parsed document and return the sections
 * that fit in the budget. Priority order:
 *
 *   1. Preamble (always included when non-empty).
 *   2. `always`-priority sections — sentinel-less sections, PLUS any
 *      section whose heading matches `alwaysIncludeHeadings`.
 *   3. `scoped` sections whose `paths` match either the active file
 *      or one of the user's mentioned paths, capped at
 *      `maxScopedSections`.
 *   4. `low`-priority sections — any section whose heading matches
 *      `lowPriorityHeadings`. Included only when budget remains.
 *
 * Overflow: whole sections drop in reverse priority order (low first,
 * then scoped, then always) until the total fits. Preamble never
 * drops — if the preamble alone exceeds the budget the caller should
 * have a larger budget or a smaller SIDECAR.md.
 */
export function selectSidecarMdSections(parsed: ParsedSidecarMd, ctx: SelectSectionsContext): SectionSelection {
  const alwaysHeadings = new Set((ctx.alwaysIncludeHeadings ?? []).map((h) => h.toLowerCase()));
  const lowHeadings = new Set((ctx.lowPriorityHeadings ?? []).map((h) => h.toLowerCase()));
  const maxScoped = ctx.maxScopedSections ?? Number.POSITIVE_INFINITY;

  // Classify every section into always / scoped / low with precedence
  // always > low > (parser-assigned scoped|always).
  const classified = parsed.sections.map((s): SidecarMdSection => {
    const headingLower = s.heading.toLowerCase();
    if (alwaysHeadings.has(headingLower)) return { ...s, priority: 'always' };
    if (lowHeadings.has(headingLower)) return { ...s, priority: 'low' };
    return s;
  });

  // Match scoped sections against active file + mentioned paths.
  const matchTargets = [...(ctx.activeFilePath ? [ctx.activeFilePath] : []), ...(ctx.mentionedPaths ?? [])];
  const scopedMatches: SidecarMdSection[] = [];
  for (const s of classified) {
    if (s.priority !== 'scoped') continue;
    if (s.paths.length === 0) continue;
    const hit = matchTargets.some((t) => pathMatchesAnyGlob(t, s.paths));
    if (hit) scopedMatches.push(s);
    if (scopedMatches.length >= maxScoped) break;
  }

  const alwaysSections = classified.filter((s) => s.priority === 'always');
  const lowSections = classified.filter((s) => s.priority === 'low');

  // Assemble in priority order, then drop from the tail on overflow.
  const ordered = [...alwaysSections, ...scopedMatches, ...lowSections];
  const kept: SidecarMdSection[] = [];
  const dropped: SidecarMdSection[] = [];

  const preambleLen = parsed.preamble.trim().length > 0 ? parsed.preamble.length + 2 : 0;
  let total = preambleLen;

  for (const s of ordered) {
    const cost = s.body.length + 2; // +2 for the `\n\n` separator
    if (total + cost <= ctx.maxChars) {
      kept.push(s);
      total += cost;
    } else {
      dropped.push(s);
    }
  }

  // Scoped sections that were *matched but pushed out by budget* still
  // belong in `droppedForBudget` so verbose logs surface them.
  // `ordered` already excluded unmatched scoped sections — they're
  // neither kept nor "dropped for budget" (they simply didn't apply).

  return {
    rendered: renderSelection(parsed.preamble, kept),
    sections: kept,
    droppedForBudget: dropped,
  };
}
