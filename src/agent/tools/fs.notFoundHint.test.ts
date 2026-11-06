import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';

// edit_file refusals and recoveries around a search that was not found.

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

// #163 ML-34: the inferred region is cut from lines split on '\n', so in a CRLF
// file it ended in the last line's '\r'. The CRLF replacement went in without
// it, leaving a bare LF -- 5 of 6 replayed inferred writes to CRLF files.
describe('an inferred edit in a CRLF file (#163 ML-34)', () => {
  const F = [
    'import os',
    'def alpha_handler(first_input, second_input, third_input):',
    '    return compute_total(fourth_value, fifth_value, sixth_value)',
    '',
    'def beta():',
    '    pass',
    '',
  ].join('\r\n');

  it('keeps every line ending CRLF', async () => {
    const write = mount(F);
    const result = await editFile(
      {
        path: 'h.py',
        search: 'def alpha_handler(first, second):\n    return 0',
        replace:
          'def alpha_handler(first_input, second_input, third_input):\n' +
          '    return compute_total(fourth_value, fifth_value, sixth_value) + 1',
      },
      ctx('h.py'),
    );
    expect(result).toMatch(/inferred/);
    const written = Buffer.from(write.mock.calls[0][1] as Uint8Array).toString();
    expect(written).toBe(F.replace('sixth_value)', 'sixth_value) + 1'));
  });
});

// #163 ML-46: with no grammar for the file, the delimiter-balance check is the
// only structural guard. The missing-search inference path applied it; the
// not-found one did not, and wrote unchecked .html files.
describe('an inferred edit in a file with no grammar (#163 ML-46)', () => {
  const F = [
    '<html>',
    '<script>',
    'function alpha_handler(first_input, second_input, third_input) {',
    '  return compute_total(fourth_value, fifth_value, sixth_value); }',
    '</script>',
    '</html>',
    '',
  ].join('\n');
  // Drops the closing brace the region has.
  const REPLACE_UNBALANCED =
    'function alpha_handler(first_input, second_input, third_input) {\n' +
    '  return compute_total(fourth_value, fifth_value, sixth_value) + 1;';

  it('is not written when it changes the bracket balance', async () => {
    const msg = await refusal('page.html', F, 'function alpha(a) {\n  return 0; }', REPLACE_UNBALANCED);
    expect(msg).toContain('The file was NOT modified');
  });

  it('is written when the balance is kept', async () => {
    const write = mount(F);
    await editFile(
      {
        path: 'page.html',
        search: 'function alpha(a) {\n  return 0; }',
        replace: REPLACE_UNBALANCED + ' }',
      },
      ctx('page.html'),
    );
    expect(write).toHaveBeenCalled();
  });
});

// #163 ML-33: every window was joined and rescanned, so a 730-line replace on a
// 3,824-line file took 48 s in the extension host. Now it is one pass.
describe('fuzzy recovery on a large file (#163 ML-33)', () => {
  const big = Array.from({ length: 3824 }, (_, i) => `    value_${i} = compute_${i % 97}(arg_${i % 31}) + offset_${i}`);
  const BIG = big.join('\n') + '\n';
  const BIG_REPLACE = big
    .slice(1500, 2230)
    .map((l) => l.replace('offset', 'shift'))
    .join('\n');

  it('answers a missing search in under 2 s', async () => {
    const t = Date.now();
    const msg = await refusal('big.py', BIG, undefined as never, BIG_REPLACE);
    expect(msg).toContain("requires 'search'");
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('answers a search that was not found in under 2 s', async () => {
    const t = Date.now();
    const msg = await refusal('big.py', BIG, BIG_REPLACE.replace(/shift/g, 'nope'), BIG_REPLACE);
    expect(msg).toContain('NOT modified');
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
