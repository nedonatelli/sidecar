/**
 * Post-generation stub validator.
 *
 * Scans code that the agent wrote (via write_file / edit_file) for
 * placeholder patterns that indicate incomplete implementation.
 * When stubs are detected, returns a reprompt message so the agent
 * loop can feed it back and ask the model to finish the work.
 */

export interface StubMatch {
  /** The file path that contains the stub */
  file: string;
  /** The matched placeholder text */
  match: string;
  /** Which pattern category triggered */
  category: string;
}

/**
 * Patterns that indicate stub / placeholder code.
 * Each entry is [category, regex].
 * Regexes are case-insensitive and match single lines.
 */
const STUB_PATTERNS: Array<[string, RegExp]> = [
  // Explicit TODO / FIXME markers
  ['todo-comment', /\/\/\s*(?:TODO|FIXME|HACK|XXX)\b[:\s]/i],
  ['todo-comment', /#\s*(?:TODO|FIXME|HACK|XXX)\b[:\s]/i],

  // "implement" / "placeholder" / "stub" / "dummy" comments
  ['placeholder-comment', /\/\/\s*(?:implement|placeholder|stub|add logic|fill in|your code|goes here|dummy)/i],
  ['placeholder-comment', /#\s*(?:implement|placeholder|stub|add logic|fill in|your code|goes here|dummy)/i],

  // (Removed comment-only hedge heuristics: "real/proper/full implementation",
  // "in a real app", and the bare "// simulating" comment. Each matches common
  // LEGITIMATE explanatory comments — "the full implementation lives in X", "in
  // a real app you'd cache this", a Monte-Carlo "# simulating N trials" note —
  // and a comment-only check can't tell them from a stub. Same destructive
  // false-positive class as the removed "for now" / "would need" hedges: a stub
  // FP spirals the model into rewrites until cycle detection bails.)

  // Simulation logger call — a CODE pattern (not a comment), a strong stub signal:
  // a real implementation doesn't log "Simulating ...".
  ['simulation-stub', /console\.log\s*\(.*[Ss]imulat/],

  // Placeholder logger calls: console.log("[tool_name] ...") or console.log("...placeholder...")
  // Models stub out tool bodies this way — a real implementation never logs its own name in brackets.
  ['placeholder-log', /console\.log\s*\(\s*['"`]\[[\w_\-]+\]/],
  ['placeholder-log', /console\.log\s*\(.*\bplaceholder\b/i],
  ['placeholder-log', /print\s*\(\s*f?['"`]\[[\w_\-]+\]/],
  ['placeholder-log', /print\s*\(.*\bplaceholder\b/i],

  // Magic-number array fills used as dummy embeddings or placeholder data
  // Array(768).fill(0.1) is never a real implementation — it's always a stub.
  ['dummy-fill', /(?:new\s+)?Array\s*\(\d+\)\s*\.fill\s*\(/],

  // Explicit "not implemented" throws
  ['not-implemented', /throw\s+new\s+Error\s*\(\s*['"`](?:not\s+implemented|todo|implement)/i],
  ['not-implemented', /raise\s+NotImplementedError/i],

  // Dummy return values with comment indicating placeholder
  ['dummy-return', /return\s+(?:null|undefined|0|''|""|false)\s*;\s*\/\/\s*(?:placeholder|temp|dummy|stub|todo)/i],

  // (Removed: "for now" hedging. `# for now` / `// for now` is one of the most
  // common LEGITIMATE explanatory comments in real code ("for now, display the
  // current value", "for now, cap at 100") — a comment-only heuristic can't tell
  // it from a real stub. Dogfooding: a strong model's correct `# For now, just
  // display current value (no-op)` triggered a false stub reprompt that spiraled
  // into full-file rewrites until cycle detection bailed. Real stubs are caught
  // by the stronger signals above + the completion gate's test run.)

  // (Removed "would be/need/require" future-deferral: "this would need a more
  // robust approach" is a common legitimate limitation note, not a stub marker.)

  // Ellipsis or "..." as code body
  ['ellipsis-body', /^\s*\.{3}\s*$/],

  // pass statement as sole function body (Python)
  ['pass-body', /^\s*pass\s*(?:#.*)?$/],

  // Inline empty body on a typed function/method (non-void return type).
  // Fires on patterns like: value(): number {}  or  pop(): T | undefined {}
  // Void methods intentionally excluded — increment(): void {} is valid.
  // (?!\s*void\b) checks past any leading whitespace so the lookahead fires
  // on the type name itself, not the space that precedes it.
  ['empty-typed-body', /\)\s*:\s*(?!\s*void\b)[\w<\[\]|& ,]+\s*\{\s*\}/],
];

/**
 * Lines that look like stubs but are actually fine — skip them.
 * These avoid false positives on legitimate uses.
 */
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
  // Comments referencing external issue trackers
  /(?:TODO|FIXME)\s*\(?\s*(?:https?:|#\d|[A-Z]+-\d)/i,
  // Comments in test files describing what to test
  /(?:it|describe|test)\s*\(/,
];

/**
 * Scan code content for stub patterns.
 * Returns an array of matches found, or empty if the code looks complete.
 */
export function detectStubs(file: string, content: string): StubMatch[] {
  const matches: StubMatch[] = [];
  const lines = content.split('\n');

  // The previous non-blank line, used for context-sensitive checks (currently
  // pass-body: a bare `pass` is only a stub when it's a function body, not when
  // it's a legitimate no-op in an except/if/loop block or an empty class).
  let prevMeaningful = '';
  const isFunctionHeader = (l: string) => /^\s*(?:async\s+)?def\b.*:\s*$/.test(l);

  for (const line of lines) {
    // Skip blank lines (don't update prevMeaningful — we want the last code line)
    if (!line.trim()) continue;

    // Skip false positives
    if (FALSE_POSITIVE_PATTERNS.some((fp) => fp.test(line))) {
      prevMeaningful = line;
      continue;
    }

    for (const [category, pattern] of STUB_PATTERNS) {
      if (pattern.test(line)) {
        // pass-body is a stub ONLY when `pass` is the sole body of a function
        // definition. A bare `pass` after except:/if:/for:/while:/try:/with:/
        // else: — or a custom exception class — is legitimate code, not a
        // placeholder. (Dogfooding: a strong model's `except: pass` triggered a
        // false stub reprompt that spiraled into a write-target thrash bail.)
        if (category === 'pass-body' && !isFunctionHeader(prevMeaningful)) {
          break;
        }
        matches.push({
          file,
          match: line.trim(),
          category,
        });
        break; // one match per line is enough
      }
    }
    prevMeaningful = line;
  }

  // Multi-line empty typed body: catches non-void methods whose body spans two
  // lines but contains only whitespace between { and }.
  // Example:
  //   value(): number {
  //   }
  const multiLineEmptyTyped = /\)\s*:\s*(?!void\b)[\w<\[\]|& ,]+\s*\{\s*\n\s*\}/g;
  for (const m of content.matchAll(multiLineEmptyTyped)) {
    matches.push({ file, match: m[0].replace(/\s+/g, ' ').trim(), category: 'empty-typed-body' });
  }

  return matches;
}

/**
 * Scan tool calls from the current iteration for stubs in written code.
 * Returns a reprompt message if stubs were found, or null if clean.
 */
export function buildStubReprompt(toolUses: Array<{ name: string; input: Record<string, unknown> }>): string | null {
  const allMatches: StubMatch[] = [];

  for (const tu of toolUses) {
    if (tu.name === 'write_file') {
      const file = (tu.input.path || tu.input.file_path) as string;
      const content = tu.input.content as string;
      if (file && content) {
        allMatches.push(...detectStubs(file, content));
      }
    } else if (tu.name === 'edit_file') {
      const file = (tu.input.path || tu.input.file_path) as string;
      const replacement = tu.input.replace as string;
      if (file && replacement) {
        allMatches.push(...detectStubs(file, replacement));
      }
    }
  }

  if (allMatches.length === 0) return null;

  // Deduplicate by file
  const byFile = new Map<string, StubMatch[]>();
  for (const m of allMatches) {
    const list = byFile.get(m.file) || [];
    list.push(m);
    byFile.set(m.file, list);
  }

  const lines: string[] = ['Your edits contain placeholder or incomplete code. Implement them fully:'];
  for (const [file, stubs] of byFile) {
    lines.push(`\n${file}:`);
    for (const s of stubs) {
      lines.push(`  - ${s.match}`);
    }
  }
  lines.push('\nReplace every placeholder with a complete, working implementation.');

  return lines.join('\n');
}
