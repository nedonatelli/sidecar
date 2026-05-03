import { describe, it, expect } from 'vitest';
import { PredictiveContext } from './shared.js';

describe('PredictiveContext', () => {
  describe('track + buildRecentEditContext', () => {
    it('returns empty string when no edits for the file', () => {
      const ctx = new PredictiveContext();
      ctx.track({ file: 'other.ts', line: 1, text: 'something', timestamp: Date.now() });
      expect(ctx.buildRecentEditContext('current.ts')).toBe('');
    });

    it('returns empty string when relevant edits have empty text', () => {
      const ctx = new PredictiveContext();
      ctx.track({ file: 'current.ts', line: 1, text: '   ', timestamp: Date.now() });
      expect(ctx.buildRecentEditContext('current.ts')).toBe('');
    });

    it('returns formatted edit context for matching file', () => {
      const ctx = new PredictiveContext();
      ctx.track({ file: 'src/app.ts', line: 5, text: 'const x = 1;', timestamp: Date.now() });
      const result = ctx.buildRecentEditContext('src/app.ts');
      expect(result).toContain('Line 6:');
      expect(result).toContain('const x = 1;');
    });

    it('limits context to the 5 most recent edits', () => {
      const ctx = new PredictiveContext();
      for (let i = 0; i < 7; i++) {
        ctx.track({ file: 'f.ts', line: i, text: `line-${i}`, timestamp: Date.now() });
      }
      const result = ctx.buildRecentEditContext('f.ts');
      const lines = result.split('\n');
      expect(lines.length).toBe(5);
    });

    it('evicts edits older than 60 seconds', () => {
      const ctx = new PredictiveContext();
      const old = Date.now() - 70_000;
      ctx.track({ file: 'f.ts', line: 0, text: 'old edit', timestamp: old });
      ctx.track({ file: 'f.ts', line: 1, text: 'new edit', timestamp: Date.now() });
      const result = ctx.buildRecentEditContext('f.ts');
      expect(result).not.toContain('old edit');
      expect(result).toContain('new edit');
    });
  });

  describe('buildCompletionUserMessage', () => {
    it('includes language and cursor marker', () => {
      const ctx = new PredictiveContext();
      const msg = ctx.buildCompletionUserMessage('prefix ', ' suffix', 'typescript', '');
      expect(msg).toContain('Language: typescript');
      expect(msg).toContain('prefix <CURSOR> suffix');
    });

    it('includes recent edits when provided', () => {
      const ctx = new PredictiveContext();
      const msg = ctx.buildCompletionUserMessage('p', 's', 'python', 'some edits here');
      expect(msg).toContain('Recent edits');
      expect(msg).toContain('some edits here');
    });

    it('omits Recent edits section when recentEdits is empty', () => {
      const ctx = new PredictiveContext();
      const msg = ctx.buildCompletionUserMessage('p', 's', 'python', '');
      expect(msg).not.toContain('Recent edits');
    });
  });

  describe('cleanCompletion', () => {
    it('strips code fences', () => {
      const result = PredictiveContext.cleanCompletion('```ts\nconst x = 1;\n```', '', '');
      expect(result).toBe('const x = 1;');
    });

    it('strips leading/trailing newlines', () => {
      const result = PredictiveContext.cleanCompletion('\n\nconst x = 1;\n\n', '', '');
      expect(result).toBe('const x = 1;');
    });

    it('removes prefix overlap at the start', () => {
      const prefix = 'const foo = ';
      const raw = 'const foo = bar()';
      const result = PredictiveContext.cleanCompletion(raw, prefix, '');
      expect(result).toBe('bar()');
    });

    it('removes suffix overlap at the end', () => {
      const suffix = 'const y = 2;';
      const raw = 'bar()' + suffix;
      const result = PredictiveContext.cleanCompletion(raw, '', suffix);
      expect(result).toBe('bar()');
    });

    it('returns unchanged text when no overlaps', () => {
      const result = PredictiveContext.cleanCompletion('bar()', 'prefix_', '_suffix');
      expect(result).toBe('bar()');
    });
  });
});
