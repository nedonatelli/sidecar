import { describe, it, expect, vi } from 'vitest';
import { repairMalformedToolUses, type ToolCallRepairDeps } from './toolCallRepair.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';

function malformed(name: string, raw: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 't1', name, input: {}, _malformedInputRaw: raw };
}

function deps(
  over: Partial<ToolCallRepairDeps> & { complete?: (...a: unknown[]) => Promise<string> },
): ToolCallRepairDeps {
  const completeWithOverrides = over.complete ? vi.fn(over.complete) : vi.fn(async () => '');
  return {
    client: { completeWithOverrides } as unknown as SideCarClient,
    schemaFor: (n) => (n === 'read_file' ? { type: 'object', properties: { path: { type: 'string' } } } : undefined),
    ...over,
  };
}

describe('repairMalformedToolUses', () => {
  it('repairs heuristically without calling the model', async () => {
    const complete = vi.fn(async () => '');
    const tu = malformed('read_file', "{path: 'a.ts',}"); // bare key + single quotes + trailing comma
    const d = deps({ complete });
    const n = await repairMalformedToolUses([tu], d);
    expect(n).toBe(1);
    expect(tu.input).toEqual({ path: 'a.ts' });
    expect(tu._malformedInputRaw).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to schema-constrained regeneration when heuristics fail', async () => {
    // Unrecoverable raw → heuristic returns null → model regenerates.
    const tu = malformed('read_file', 'path is a.ts probably');
    const complete = vi.fn(async () => '{"path":"a.ts"}');
    const d = deps({ complete });
    const n = await repairMalformedToolUses([tu], d);
    expect(n).toBe(1);
    expect(tu.input).toEqual({ path: 'a.ts' });
    expect(complete).toHaveBeenCalledOnce();
    // The tool's schema is passed as the responseFormat (6th arg).
    expect((complete.mock.calls[0] as unknown[])[5]).toMatchObject({ type: 'object' });
  });

  it('repairs the model output too if it comes back lightly malformed', async () => {
    const tu = malformed('read_file', 'no json here');
    const complete = vi.fn(async () => '```json\n{path: "a.ts"}\n```'); // fenced + bare key
    const n = await repairMalformedToolUses([tu], deps({ complete }));
    expect(n).toBe(1);
    expect(tu.input).toEqual({ path: 'a.ts' });
  });

  it('leaves the call malformed when no schema is known', async () => {
    const complete = vi.fn(async () => '{"x":1}');
    const tu = malformed('unknown_tool', 'garbage');
    const n = await repairMalformedToolUses([tu], deps({ complete }));
    expect(n).toBe(0);
    expect(tu._malformedInputRaw).toBe('garbage');
    expect(complete).not.toHaveBeenCalled();
  });

  it('leaves the call malformed when regeneration is unparseable', async () => {
    const tu = malformed('read_file', 'garbage');
    const complete = vi.fn(async () => 'still not json');
    const n = await repairMalformedToolUses([tu], deps({ complete }));
    expect(n).toBe(0);
    expect(tu._malformedInputRaw).toBe('garbage');
  });

  it('ignores well-formed tool uses', async () => {
    const ok: ToolUseContentBlock = { type: 'tool_use', id: 't', name: 'read_file', input: { path: 'a.ts' } };
    expect(await repairMalformedToolUses([ok], deps({}))).toBe(0);
  });

  it('propagates abort', async () => {
    const tu = malformed('read_file', 'garbage');
    const complete = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(repairMalformedToolUses([tu], deps({ complete }))).rejects.toThrow('aborted');
  });
});
