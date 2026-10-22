import { describe, it, expect, vi } from 'vitest';
import { languages, workspace, type Uri } from 'vscode';
import { executeTool } from './executor.js';

// #165 ML-38: edit_file's stub diagnostics were computed from the `replace`
// snippet, so their line numbers were the snippet's, and because a report
// replaces the file's whole set, stubs found earlier in the file disappeared.

vi.mock('../config/settings.js', () => ({
  getConfig: vi.fn(() => ({ toolPermissions: {}, hooks: {} })),
}));
vi.mock('./tools.js', () => ({ findTool: vi.fn() }));

import { findTool } from './tools.js';

// The file as the edit left it: a stub from before on line 2, and the one this
// edit added on line 10.
const AFTER = [
  'export function a(): number {',
  '  // TODO: handle negatives',
  '  return 1;',
  '}',
  '',
  'export function b(): number {',
  '  return 2;',
  '}',
  '',
  "export function c(): never { throw new Error('not implemented'); }",
  '',
].join('\n');

describe('edit_file stub diagnostics cover the whole file (#165 ML-38)', () => {
  it('reports every stub in the file, at its line in the file', async () => {
    const shown = new Map<string, { source?: string; range: { start: { line: number } } }[]>();
    vi.spyOn(languages, 'createDiagnosticCollection').mockReturnValue({
      set: (uri: Uri, d: never[]) => shown.set(uri.toString(), d),
      delete: (uri: Uri) => shown.delete(uri.toString()),
      clear: () => shown.clear(),
      dispose: () => {},
    } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(AFTER) as never);
    vi.mocked(findTool).mockReturnValue({
      definition: { name: 'edit_file', description: '', input_schema: { type: 'object', properties: {} } },
      requiresApproval: false,
      executor: async () => 'File edited: src/a.ts',
    } as never);

    await executeTool(
      {
        type: 'tool_use',
        id: 'e1',
        name: 'edit_file',
        input: {
          path: 'src/a.ts',
          search: 'export function c(): never {}',
          replace: "export function c(): never { throw new Error('not implemented'); }",
        },
      },
      { approvalMode: 'autonomous' },
    );

    const stubs = [...shown.values()].flat().filter((d) => d.source === 'sidecar-stubs');
    // 0-based lines: the old TODO on line 2, the new stub on line 10.
    expect(stubs.map((d) => d.range.start.line).sort((x, y) => x - y)).toEqual([1, 9]);
  });
});
