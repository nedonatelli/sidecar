import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';

// #161 ML-07: when a multi-line search was not found, the grep hint won over
// the nearest-region block whenever grep hit anything. Its first two long
// words are usually generic, so it pointed above the block the search copies,
// with a 5-line read_file range that could not hold the search. Over recorded
// runs the block overlapped the intended region in 526/563 confident cases,
// the grep range in 103.

function mount(text: string) {
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(text) as never);
  return vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
}
const ctx = (file: string) => ({ config: { agentMode: 'agent' }, filesReadThisTurn: new Set([file]) }) as never;

async function refusal(file: string, text: string, search: string, replace: string): Promise<string> {
  const write = mount(text);
  const message = await editFile({ path: file, search, replace }, ctx(file)).then(
    (r) => `APPLIED: ${r}`,
    (e: Error) => e.message,
  );
  expect(write, message).not.toHaveBeenCalled();
  return message;
}

afterEach(() => vi.restoreAllMocks());

// The shape of django-11583's autoreload.py: words from the search appear in
// the file's header, and the block the search copies starts much further down.
const header = [
  'import itertools',
  'import sys',
  'from pathlib import Path',
  '# modules and extra files are watched for changes',
  'def watched_files(modules):',
  '    return modules',
];
const filler = Array.from({ length: 36 }, (_, i) => `CONSTANT_${i} = ${i}`);
const block = [
  'def iter_modules_and_files(modules, extra_files):',
  '    results = set()',
  '    for filename in itertools.chain(sys_file_paths, map(str, extra_files)):',
  '        path = Path(filename)',
  '        try:',
  '            resolved_path = path.resolve(strict=True).absolute()',
  '        except FileNotFoundError:',
  '            continue',
  '        results.add(resolved_path)',
  '    return frozenset(results)',
];
const FILE = [...header, ...filler, ...block, ''].join('\n');
// The search copies the block but drops `strict=True`.
const SEARCH = block.slice(0, 6).join('\n').replace('resolve(strict=True)', 'resolve()');
// Mostly new words, so the replace-based region inference stays out of it and
// the not-found hint is what the model gets.
const REPLACE =
  'def iter_modules_and_files(modules, extra_files):\n    cache = build_watch_cache(extra_files)\n    yield from cache.entries()';

describe('a multi-line search that was not found (#161 ML-07)', () => {
  it('shows the nearest region the search copies, not a grep hit above it', async () => {
    const msg = await refusal('autoreload.py', FILE, SEARCH, REPLACE);
    expect(msg).toContain('search string not found');
    expect(msg).toContain('resolved_path = path.resolve(strict=True).absolute()');
    expect(msg).not.toMatch(/Grep for \[/);
  });

  it('keeps the grep hint first for a single-line search', async () => {
    const msg = await refusal('autoreload.py', FILE, 'def watched_files(modules, strict=True):', 'x = 1');
    expect(msg).toMatch(/Grep for \[/);
  });
});

// #161 ML-31: the locator was matched byte-exact, so a multi-line `within`
// written with LF never resolved in a CRLF file -- 73 of 77 recorded failures
// of such a locator were this.
describe('a multi-line within in a CRLF file (#161 ML-31)', () => {
  const AB =
    'class A:\r\n    def run(self):\r\n        return 1\r\n\r\nclass B:\r\n    def run(self):\r\n        return 1\r\n';

  it('resolves, and the edit lands at the occurrence it names', async () => {
    const write = mount(AB);
    const result = await editFile(
      {
        path: 'ab.py',
        search: '        return 1',
        replace: '        return 2',
        within: 'class B:\n    def run(self):',
      },
      ctx('ab.py'),
    );
    expect(result).not.toMatch(/Error/);
    const written = Buffer.from(write.mock.calls[0][1] as Uint8Array).toString();
    expect(written).toBe(AB.replace(/return 1\r\n$/, 'return 2\r\n'));
  });
});

describe('the grep hint', () => {
  it('offers a read_file range as tall as the search, not a fixed 5 lines', async () => {
    // Grep hits the header; no 13-line window holds enough of the search for a region.
    const search = [
      'def watched_files(modules):',
      ...Array.from({ length: 12 }, (_, i) => `    zzz_unknown_${i}()`),
    ].join('\n');
    const msg = await refusal('autoreload.py', FILE, search, 'x = 1');
    const m = /start_line=(\d+), end_line=(\d+)/.exec(msg);
    expect(m, msg).not.toBeNull();
    expect(Number(m![2]) - Number(m![1]) + 1).toBeGreaterThanOrEqual(13);
  });
});
