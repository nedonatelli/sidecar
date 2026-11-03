import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile, writeFile, deleteFile, fsTools } from './fs.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';
import { changedFiles, fileToolName, type ToolOutcome } from './toolOutcome.js';

// ADR-008: every exit of the three file tools that returns says what it did to
// the workspace. A throw reports nothing here; the executor turns it into
// `failed` (executor.test.ts).

function mount(text: string | undefined) {
  if (text === undefined) vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
  else vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(text) as never);
  return vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
}

/** A context whose sink keeps every report, and the reports themselves. */
function sink(extra: Record<string, unknown> = {}) {
  const reports: ToolOutcome[] = [];
  const ctx = {
    config: { agentMode: 'agent' },
    filesReadThisTurn: new Set(['a.py']),
    recordOutcome: (o: ToolOutcome) => reports.push(o),
    ...extra,
  } as never;
  return { ctx, reports, last: () => reports[reports.length - 1] };
}

const PY = 'def total(xs):\n    return sum(xs)\n\n\ndef mean(xs):\n    return total(xs) / len(xs)\n';

// A search that is close but wrong, which edit_file resolves by inference (#362).
const ORDERS =
  'def compute_total(prices, tax_rate):\n' +
  '    subtotal = sum(prices)\n' +
  '    return subtotal * (1 + tax_rate) + shipping_fee + handling_cost\n' +
  '\n' +
  'def describe_order(order_id, customer_name):\n' +
  "    return f'{order_id}: {customer_name}'\n";
const INFERRED = {
  path: 'orders.py',
  search: '    return subtotal*(1+tax)',
  replace: '    return round(subtotal * (1 + tax_rate) + shipping_fee + handling_cost, 2)',
};

afterEach(() => {
  vi.restoreAllMocks();
  getDefaultAuditBuffer().clear();
});

describe('changedFiles / fileToolName', () => {
  it('only a mutated outcome changed files', () => {
    expect(changedFiles({ kind: 'mutated', paths: ['a.py'] })).toEqual(['a.py']);
    expect(changedFiles({ kind: 'mutated', paths: ['a.py'], staged: 'review' })).toEqual(['a.py']);
    expect(changedFiles({ kind: 'noop', paths: ['a.py'] })).toEqual([]);
    expect(changedFiles({ kind: 'failed', paths: ['a.py'] })).toEqual([]);
    expect(changedFiles(undefined)).toEqual([]);
  });

  it('resolves aliases to the file tool they run as', () => {
    expect(fileToolName('edit_file')).toBe('edit_file');
    expect(fileToolName('str_replace')).toBe('edit_file');
    expect(fileToolName('create_file')).toBe('write_file');
    expect(fileToolName('rm')).toBe('delete_file');
    expect(fileToolName('read_file')).toBeNull();
    expect(fileToolName('apply_patch')).toBeNull();
  });
});

describe('edit_file reports its outcome', () => {
  it('a landed edit is mutated', async () => {
    mount(PY);
    const s = sink();
    await editFile({ path: 'a.py', search: 'return sum(xs)', replace: 'return sum(xs, 0)' }, s.ctx);
    expect(s.reports).toEqual([{ kind: 'mutated', paths: ['a.py'] }]);
  });

  it('an edit already applied is noop', async () => {
    mount(PY.replace('return sum(xs)', 'return sum(xs, 0)'));
    const s = sink();
    const text = await editFile({ path: 'a.py', search: 'return sum(xs)', replace: 'return sum(xs, 0)' }, s.ctx);
    expect(text).toMatch(/^No change needed/);
    expect(s.reports).toEqual([{ kind: 'noop', paths: ['a.py'] }]);
  });

  it('a replace equal to the text the indent tier matched is noop (ML-05)', async () => {
    const write = mount('class Formset:\r\n@cached_property\r\ndef management_form(self):\r\n    return 1\r\n');
    const s = sink({ filesReadThisTurn: new Set(['runtests.py']) });
    await editFile(
      {
        path: 'runtests.py',
        search: '    @cached_property\n    def management_form(self):',
        replace: '@cached_property\ndef management_form(self):',
      },
      s.ctx,
    );
    expect(write).not.toHaveBeenCalled();
    expect(s.last()).toEqual({ kind: 'noop', paths: ['runtests.py'] });
  });

  it('an inferred edit is mutated, though no "File edited:" line says so', async () => {
    mount(ORDERS);
    const s = sink({ filesReadThisTurn: new Set(['orders.py']) });
    const text = await editFile(INFERRED, s.ctx);
    expect(text).toMatch(/Applied inferred edit to orders\.py/);
    expect(text).not.toContain('File edited:');
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['orders.py'] });
  });

  it('an edit to a missing file writes it whole, and is mutated', async () => {
    mount(undefined);
    const s = sink();
    await editFile({ path: 'new.py', replace: 'x = 1\n' }, s.ctx);
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['new.py'] });
  });

  it('a search that matches nothing throws and reports nothing', async () => {
    mount(PY);
    const s = sink();
    await expect(
      editFile({ path: 'a.py', search: 'def median(xs):', replace: 'def median(ys):' }, s.ctx),
    ).rejects.toThrow();
    expect(s.reports).toEqual([]);
  });

  it('an audit-mode edit is mutated and staged', async () => {
    mount(PY);
    const s = sink({ config: { agentMode: 'audit' } });
    await editFile({ path: 'a.py', search: 'return sum(xs)', replace: 'return sum(xs, 0)' }, s.ctx);
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['a.py'], staged: 'audit' });
  });
});

describe('write_file and delete_file report their outcome', () => {
  it('a write is mutated, and the path is forward-slashed', async () => {
    mount(undefined);
    const s = sink();
    await writeFile({ path: 'src\\pkg\\b.py', content: 'y = 2\n' }, s.ctx);
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['src/pkg/b.py'] });
  });

  it('a rewrite identical to a version written earlier this run is noop', async () => {
    mount(undefined);
    const s = sink({ writeHistoryByFile: new Map() });
    await writeFile({ path: 'b.py', content: 'y = 2\n' }, s.ctx);
    await writeFile({ path: 'b.py', content: 'y = 2\n' }, s.ctx);
    expect(s.reports).toEqual([
      { kind: 'mutated', paths: ['b.py'] },
      { kind: 'noop', paths: ['b.py'] },
    ]);
  });

  it('an audit-mode write is mutated and staged', async () => {
    mount(undefined);
    const s = sink({ config: { agentMode: 'audit' } });
    await writeFile({ path: 'b.py', content: 'y = 2\n' }, s.ctx);
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['b.py'], staged: 'audit' });
  });

  it('a delete is mutated', async () => {
    const s = sink();
    await deleteFile({ path: 'b.py' }, s.ctx);
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['b.py'] });
  });
});

describe('the stale-read mark follows the outcome (#362)', () => {
  const registered = (name: string) => fsTools.find((t) => t.definition.name === name)!.executor;

  it('an inferred edit marks the file edited since read', async () => {
    mount(ORDERS);
    const editedSinceRead = new Set<string>();
    await registered('edit_file')(INFERRED, {
      config: { agentMode: 'agent' },
      filesReadThisTurn: new Set(['orders.py']),
      editedSinceRead,
    } as never);
    expect([...editedSinceRead]).toEqual(['orders.py']);
  });

  it('an edit already applied does not', async () => {
    mount(PY.replace('return sum(xs)', 'return sum(xs, 0)'));
    const editedSinceRead = new Set<string>();
    await registered('edit_file')({ path: 'a.py', search: 'return sum(xs)', replace: 'return sum(xs, 0)' }, {
      config: { agentMode: 'agent' },
      filesReadThisTurn: new Set(['a.py']),
      editedSinceRead,
    } as never);
    expect(editedSinceRead.size).toBe(0);
  });

  it('still forwards the report to the executor sink', async () => {
    mount(PY);
    const s = sink({ editedSinceRead: new Set<string>() });
    await registered('edit_file')({ path: 'a.py', search: 'return sum(xs)', replace: 'return sum(xs, 0)' }, s.ctx);
    expect(s.last()).toEqual({ kind: 'mutated', paths: ['a.py'] });
  });
});
