import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';
import type { AgentDecision } from '../decisions.js';

// #163 ML-20: when `search` is not found, edit_file may infer the region from
// `replace` alone, by word overlap, in a window as tall as replace. That APPLY
// tier now declines -- and the suggest tier quotes the region instead, writing
// nothing -- when the inferred write would put wrong bytes on disk.

function mount(text: string) {
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(text) as never);
  return vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
}
const written = (write: ReturnType<typeof mount>): string =>
  Buffer.from(write.mock.calls[0][1] as Uint8Array).toString();

function ctx(file: string) {
  const decisions: AgentDecision[] = [];
  const context = {
    config: { agentMode: 'agent' },
    filesReadThisTurn: new Set([file]),
    logDecision: (d: AgentDecision) => decisions.push(d),
  } as never;
  return { context, decisions };
}

afterEach(() => vi.restoreAllMocks());

// A string the file splits across two lines (django-15902, formsets.py).
const FORMSETS = [
  'class ManagementForm(Form):',
  '    def clean(self):',
  '        cleaned_data = super().clean()',
  '        if missing:',
  '            raise ValidationError(',
  '                "ManagementForm data is missing or has been tampered with. Missing fields: "',
  '                "%(field_names)s.",',
  '                code="missing_management_form",',
  '            )',
  '        return cleaned_data',
  '',
].join('\n');

const ORDERS =
  'def compute_total(prices, tax_rate):\n' +
  '    subtotal = sum(prices)\n' +
  '    return subtotal * (1 + tax_rate) + shipping_fee + handling_cost\n' +
  '\n' +
  'def describe_order(order_id, customer_name):\n' +
  "    return f'{order_id}: {customer_name}'\n";

describe('the inferred-edit APPLY tier declines a write that would be wrong (#163 ML-20)', () => {
  it('when the region it picked is cut short: the string continues on the next line', async () => {
    const write = mount(FORMSETS);
    const { context } = ctx('formsets.py');
    const call = editFile(
      {
        path: 'formsets.py',
        search: '"ManagementForm data is missing or has been tampered with. Missing fields: %(field_names)s."',
        replace:
          '                "ManagementForm data is missing or has been tampered with. Missing fields: %(field_names)s. ' +
          'You may need to file a bug report.",',
      },
      context,
    );
    await expect(call).rejects.toThrow(/does not appear in the file/);
    expect(write).not.toHaveBeenCalled();
  });

  it("when replace's indentation differs from the region's", async () => {
    const write = mount(ORDERS);
    const { context } = ctx('orders.py');
    const call = editFile(
      {
        path: 'orders.py',
        search: 'return subtotal*(1+tax)',
        replace: 'return round(subtotal * (1 + tax_rate) + shipping_fee + handling_cost, 2)',
      },
      context,
    );
    await expect(call).rejects.toThrow(/does not appear in the file/);
    expect(write).not.toHaveBeenCalled();
  });

  it('when replace carries literal \\n escapes the region does not', async () => {
    const doc = [
      '## Configuration',
      '',
      'The server reads its configuration from settings.ini at startup.',
      'Restart the service after changing any value.',
      '',
    ].join('\n');
    const write = mount(doc);
    const { context } = ctx('README.md');
    const call = editFile(
      {
        path: 'README.md',
        search: 'The server reads its config from settings.ini.',
        replace:
          'The server reads its configuration from settings.ini at startup, and again on SIGHUP.\\nNo reload step is needed.',
      },
      context,
    );
    await expect(call).rejects.toThrow(/does not appear in the file/);
    expect(write).not.toHaveBeenCalled();
  });

  it('still applies when the region is whole, aligned, and free of escapes', async () => {
    const write = mount(ORDERS);
    const { context } = ctx('orders.py');
    const text = await editFile(
      {
        path: 'orders.py',
        search: '    return subtotal*(1+tax)',
        replace: '    return round(subtotal * (1 + tax_rate) + shipping_fee + handling_cost, 2)',
      },
      context,
    );
    expect(text).toMatch(/Applied inferred edit to orders\.py/);
    expect(written(write)).toContain('    return round(subtotal * (1 + tax_rate) + shipping_fee + handling_cost, 2)\n');
  });
});

describe('an inferred edit records its tier and parse verdict (#163 ML-71)', () => {
  it('edit_outcome says tier "inferred" and carries the syntax guard\'s verdict', async () => {
    mount(ORDERS);
    const { context, decisions } = ctx('orders.py');
    await editFile(
      {
        path: 'orders.py',
        search: '    return subtotal*(1+tax)',
        replace: '    return round(subtotal * (1 + tax_rate) + shipping_fee + handling_cost, 2)',
      },
      context,
    );
    const outcome = decisions.find((d) => d.kind === 'edit_outcome');
    expect(outcome).toMatchObject({ applied: true, tier: 'inferred' });
  });
});
