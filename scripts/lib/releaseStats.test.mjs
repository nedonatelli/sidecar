import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { deriveToolCount, deriveSkillCount, releaseDate } from './releaseStats.mjs';

// The counters used to shell out (`find … -exec grep`, `ls … | wc -l`). Under
// cmd.exe `find.exe` is a string search, so the tool count came back wrong
// without an error and the skill count threw — the release check could not run
// on a Windows workstation. These pin the Node implementation against an
// independent walk over the same files.

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

describe('releaseStats counters (no shell)', () => {
  it('counts line-leading tool names across src/agent/tools/*.ts and tools.ts, excluding tests', () => {
    const files = [
      ...walk('src/agent/tools').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
      'src/agent/tools.ts',
    ];
    let expected = 0;
    for (const f of files) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (/^[ \t]*name: ['"][a-z_]+['"]/.test(line)) expected++;
      }
    }
    expect(expected).toBeGreaterThan(50);
    expect(deriveToolCount()).toBe(expected);
  });

  it('counts skills/*.md', () => {
    expect(deriveSkillCount()).toBe(readdirSync('skills').filter((f) => f.endsWith('.md')).length);
    expect(deriveSkillCount()).toBeGreaterThan(0);
  });
});

describe('releaseDate -- the LOCAL calendar date, not UTC', () => {
  // Both release scripts used new Date().toISOString().slice(0, 10), which is
  // the UTC date. v0.126.0 was cut at 20:14 EDT on Oct 5 and stamped
  // 2026-10-06; verify:release agreed only because it made the same mistake.
  it('an evening release keeps its own day', () => {
    expect(releaseDate(new Date(2026, 9, 5, 20, 14))).toBe('2026-10-05');
    expect(releaseDate(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
  });

  it('a morning release keeps its own day', () => {
    expect(releaseDate(new Date(2026, 9, 6, 0, 1))).toBe('2026-10-06');
  });

  it('pads month and day to two digits', () => {
    expect(releaseDate(new Date(2027, 0, 3, 12, 0))).toBe('2027-01-03');
  });
});
