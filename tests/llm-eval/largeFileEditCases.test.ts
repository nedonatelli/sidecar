import { describe, it, expect } from 'vitest';
import { LARGE_FILE_EDIT_CASES, VALIDATOR_MODULE } from './largeFileEditCases.js';
import { ALL_AGENT_CASES } from './allCases.js';

// These cases only carry signal while their fixture stays in the regime where
// edit_file actually fails: big file, deep nesting, repeated anchors, and a
// prompt that refuses to hand over the replacement text. Each of those is one
// "harmless" simplification away from turning the family back into the 20-line
// cases that missed the bug for eight weeks. This test is what makes that
// simplification fail loudly instead of silently.

const BOUNDS_ANCHOR = '        if value > self.maximum:';

describe('large-file edit fixture', () => {
  it('is large enough to leave the regime the rest of the suite covers', () => {
    const lines = VALIDATOR_MODULE.split('\n').length;
    // The llm-eval convention is ~20 lines; SWE-bench files run 399-2091.
    expect(lines).toBeGreaterThan(400);
  });

  it('nests deeply enough that indentation is hard to reproduce from memory', () => {
    const deepest = Math.max(
      ...VALIDATOR_MODULE.split('\n')
        .filter((l) => l.trim())
        .map((l) => l.length - l.trimStart().length),
    );
    // `raise ValidationError` sits four levels in. Python indentation is
    // syntax, so this is the depth that produces "search string not found".
    expect(deepest).toBeGreaterThanOrEqual(20);
  });

  it('repeats the target anchor, so a bare search is ambiguous', () => {
    const occurrences = VALIDATOR_MODULE.split(BOUNDS_ANCHOR).length - 1;
    // Twenty identical bounds checks: the exact "search appears N times"
    // failure, which a fixture of unique one-line anchors cannot produce.
    expect(occurrences).toBe(20);
  });

  it('still leaves the target disambiguable via nearby context', () => {
    // An anchor with NO disambiguator would make the case unwinnable rather
    // than hard. The per-class docstring three lines up is the intended handle.
    for (const marker of ['"""Bounds check for field13."""', '"""Bounds check for field7."""']) {
      expect(VALIDATOR_MODULE.split(marker).length - 1).toBe(1);
    }
  });

  it('places the targets deep in the file, not in the opening window', () => {
    const total = VALIDATOR_MODULE.length;
    for (const marker of ['class FieldValidator7:', 'class FieldValidator13:']) {
      // Past the point a truncated or head-only read would reach.
      expect(VALIDATOR_MODULE.indexOf(marker) / total).toBeGreaterThan(0.3);
    }
  });
});

describe('large-file edit cases', () => {
  const byId = Object.fromEntries(LARGE_FILE_EDIT_CASES.map((c) => [c.id, c]));

  it('states every change as intent, never as literal search/replace text', () => {
    // The property that makes these discriminating. `dogfood-large-file-edit`
    // says "returns value * 47 instead of value + 47" — handing over both
    // fields, which is why it cannot produce a search===replace failure.
    // Quoting file text is the specific sin: whatever the prompt spells out is
    // text the model no longer has to locate and copy byte-exactly itself.
    for (const c of LARGE_FILE_EDIT_CASES) {
      expect(c.userMessage, `${c.id} must not quote the file's code`).not.toMatch(/self\.maximum|>=|return False/);
    }
  });

  it('expects an edit that differs from the fixture by exactly one line', () => {
    const expected = byId['large-file-derived-boundary-edit'].expect.files?.equal?.[0].content ?? '';
    const before = VALIDATOR_MODULE.split('\n');
    const after = expected.split('\n');
    expect(after.length).toBe(before.length);
    const changed = before.map((l, i) => [l, after[i]] as const).filter(([a, b]) => a !== b);
    expect(changed).toEqual([[BOUNDS_ANCHOR, '        if value >= self.maximum:']]);
  });

  it('has an insertion assertion that rejects the unedited file and accepts the correct edit', () => {
    // Proving the expectation trips — a regex that matches the pristine fixture
    // would mark every failed run as a pass.
    const pattern = byId['large-file-anchored-insertion'].expect.files?.matchesRegex?.[0].patterns[0];
    expect(pattern).toBeDefined();
    expect(VALIDATOR_MODULE).not.toMatch(pattern!);

    const correct = VALIDATOR_MODULE.replace(
      '        """Bounds check for field7."""\n        if value is None:\n            return False\n',
      '        """Bounds check for field7."""\n        if value is None:\n            return False\n' +
        '        if value < 0:\n            return False\n',
    );
    expect(correct).not.toBe(VALIDATOR_MODULE);
    expect(correct).toMatch(pattern!);
  });

  it('rejects the anchor-dropped corruption the insertion prompt invites', () => {
    // Dropping the anchor from `replace` deletes it. The notContain guards must
    // fire on that shape, not just on a missing insertion.
    const corrupted = VALIDATOR_MODULE.replace(
      '        """Bounds check for field7."""\n        if value is None:\n            return False\n',
      '        """Bounds check for field7."""\n        if value < 0:\n            return False\n',
    );
    const banned = byId['large-file-anchored-insertion'].expect.files?.notContain?.[0].substrings ?? [];
    expect(banned.some((s) => corrupted.includes(s))).toBe(true);
  });

  it('keeps one case under compression, so context pressure is an isolated variable', () => {
    const compressed = byId['large-file-edit-under-compression'];
    const uncompressed = byId['large-file-derived-boundary-edit'];
    expect(compressed.maxTokens).toBeLessThan(12_000);
    expect(uncompressed.maxTokens).toBeUndefined();
    // Same target and prompt: a pass/fail split between them is context
    // pressure and nothing else.
    expect(compressed.userMessage).toBe(uncompressed.userMessage);
  });

  it('is registered in the single case list both suites run', () => {
    const ids = new Set(ALL_AGENT_CASES.map((c) => c.id));
    for (const c of LARGE_FILE_EDIT_CASES) expect(ids, `${c.id} must be registered`).toContain(c.id);
  });
});
