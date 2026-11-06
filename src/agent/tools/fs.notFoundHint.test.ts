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
