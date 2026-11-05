import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile, fsTools } from './fs.js';

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

async function refusal(file: string, text: string, search: string, replace: string, within?: string): Promise<string> {
  const write = mount(text);
  const message = await editFile({ path: file, search, replace, ...(within ? { within } : {}) }, ctx(file)).then(
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

// Shown the region, the model edited without reading in 14 of 16 paired runs,
// 6 of them resending the search that had just missed; one sent it with a new
// `within` until the turn cap. A resent search is told to read the region's
// lines, and every miss on the file gets that until a read shows them.
describe('a resent search that already missed (#161 ML-07)', () => {
  const read = fsTools.find((t) => t.definition.name === 'read_file')!.executor;
  const loopCtx = () =>
    ({
      config: { agentMode: 'agent' },
      filesReadThisTurn: new Set(['autoreload.py']),
      editFailureSignatures: new Map<string, string>(),
    }) as never;
  const edit = (context: never, search: string, replace = REPLACE, within?: string) =>
    editFile({ path: 'autoreload.py', search, replace, ...(within ? { within } : {}) }, context).then(
      (r) => `APPLIED: ${r}`,
      (e: Error) => e.message,
    );
  // The region the hint showed is lines 40-51 of FILE; the range adds two lines each side.
  const READ_CALL = 'read_file(path="autoreload.py", start_line=38, end_line=53)';

  it('is told to read the region, even with a new replace and a within', async () => {
    const write = mount(FILE);
    const context = loopCtx();
    expect(await edit(context, SEARCH)).toContain('search string not found');
    const again = await edit(
      context,
      SEARCH,
      `${REPLACE}\n    pass`,
      'def iter_modules_and_files(modules, extra_files):',
    );
    expect(again).toContain('resent a search that already missed');
    expect(again).toContain(READ_CALL);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps answering any miss with the read until the lines are read', async () => {
    mount(FILE);
    const context = loopCtx();
    await edit(context, SEARCH);
    await edit(context, SEARCH);
    expect(await edit(context, 'def something_else():\n    return 2')).toContain(READ_CALL);
  });

  it('still applies a search that matches', async () => {
    const write = mount(FILE);
    const context = loopCtx();
    await edit(context, SEARCH);
    await edit(context, SEARCH);
    expect(await edit(context, '    results = set()', '    results = {}')).toMatch(/^APPLIED/);
    expect(write).toHaveBeenCalled();
  });

  it('is lifted by a read that shows the lines, not by one elsewhere or a compact read', async () => {
    mount(FILE);
    const context = loopCtx();
    await edit(context, SEARCH);
    await edit(context, SEARCH);
    await read({ path: 'autoreload.py', start_line: 1, end_line: 10 }, context);
    await read({ path: 'autoreload.py', mode: 'compact' }, context);
    expect(await edit(context, SEARCH)).toContain(READ_CALL);
    await read({ path: 'autoreload.py', start_line: 45, end_line: 60 }, context);
    const after = await edit(context, SEARCH);
    expect(after).toContain('search string not found');
    expect(after).not.toContain('resent a search');
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

// #161 ML-74: `within` marks where the search begins, so a search that occurs
// only ABOVE the locator is outside the slice. With one whole-file occurrence
// the fallback takes it; with two, the model was told "search string not
// found" about text plainly in the file.
describe('a search that occurs only above its within (#161 ML-74)', () => {
  const F = 'def a():\n    return 1\n\ndef b():\n    return 1\n\ndef c():\n    return 3\n';

  it('says where the occurrences are, instead of "not found"', async () => {
    const msg = await refusal('f.py', F, '    return 1', '    return 2', 'def c():');
    expect(msg).not.toContain('search string not found');
    expect(msg).toMatch(/2 times/);
    expect(msg).toMatch(/lines? 2, 5/);
    expect(msg).toMatch(/above/);
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
