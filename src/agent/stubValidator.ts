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

  // "real implementation" deferral — also catches "REAL IMPLEMENTATION REQUIRED" banners
  ['deferred-implementation', /(?:real|actual|full|proper)\s+implementation/i],
  ['deferred-implementation', /in\s+a\s+real\s+(?:app|system|project)/i],

  // Simulation / pretend placeholders (e.g. console.log("Simulating retrieval..."))
  ['simulation-stub', /console\.log\s*\(.*[Ss]imulat/],
  ['simulation-stub', /\/\/\s*[Ss]imulat(?:ing|ed|ion)/],

  // Magic-number array fills used as dummy embeddings or placeholder data
  // Array(768).fill(0.1) is never a real implementation — it's always a stub.
  ['dummy-fill', /(?:new\s+)?Array\s*\(\d+\)\s*\.fill\s*\(/],

  // Explicit "not implemented" throws
  ['not-implemented', /throw\s+new\s+Error\s*\(\s*['"`](?:not\s+implemented|todo|implement)/i],
  ['not-implemented', /raise\s+NotImplementedError/i],

  // Dummy return values with comment indicating placeholder
  ['dummy-return', /return\s+(?:null|undefined|0|''|""|false)\s*;\s*\/\/\s*(?:placeholder|temp|dummy|stub|todo)/i],

  // "for now" / "for the time being" hedging
  ['for-now-hedge', /\/\/\s*for\s+now\b/i],
  ['for-now-hedge', /#\s*for\s+now\b/i],

  // "would be" / "would need" / "would require" future tense deferral
  ['future-deferral', /\/\/\s*(?:this\s+)?would\s+(?:be|need|require)\b/i],

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

  for (const line of lines) {
    // Skip blank lines
    if (!line.trim()) continue;

    // Skip false positives
    if (FALSE_POSITIVE_PATTERNS.some((fp) => fp.test(line))) continue;

    for (const [category, pattern] of STUB_PATTERNS) {
      if (pattern.test(line)) {
        matches.push({
          file,
          match: line.trim(),
          category,
        });
        break; // one match per line is enough
      }
    }
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
