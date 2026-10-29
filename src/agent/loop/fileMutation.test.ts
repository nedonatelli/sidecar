import { describe, it, expect } from 'vitest';
import { countsAsFileMutation } from './fileMutation.js';

const result = (content: string, is_error = false) => ({
  type: 'tool_result' as const,
  tool_use_id: 't',
  content,
  is_error,
});

describe('countsAsFileMutation (#361)', () => {
  it('counts a file tool result that changed a file', () => {
    expect(countsAsFileMutation('edit_file', result('File edited: src/a.py\nWhat changed: ...'))).toBe(true);
    expect(countsAsFileMutation('write_file', result('File written: src/b.py'))).toBe(true);
    expect(countsAsFileMutation('delete_file', result('Deleted src/c.py'))).toBe(true);
    expect(countsAsFileMutation('edit_file', result('Applied inferred edit to src/a.py: your search ...'))).toBe(true);
  });

  it('does not count "No change needed", alone or after a tolerance note', () => {
    expect(
      countsAsFileMutation('edit_file', result('No change needed: src/a.py already has this text — your replacement')),
    ).toBe(false);
    expect(
      countsAsFileMutation(
        'edit_file',
        result(
          '[note: your search differed in trailing whitespace only.]\nNo change needed: src/a.py already contains',
        ),
      ),
    ).toBe(false);
    expect(
      countsAsFileMutation('write_file', result('No change needed: `src/b.py` already matches this content')),
    ).toBe(false);
  });

  it('does not count errors, other tools, or a missing result', () => {
    expect(countsAsFileMutation('edit_file', result('Search text not found', true))).toBe(false);
    expect(countsAsFileMutation('read_file', result('File edited: looks like it but is a read'))).toBe(false);
    expect(countsAsFileMutation(undefined, result('File edited: x'))).toBe(false);
    expect(countsAsFileMutation('edit_file', undefined)).toBe(false);
  });
});
