import { describe, it, expect } from 'vitest';
import { applyIsolateRewriteNudge } from './isolateRewrite.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

function writeFile(path: string, content = 'x'): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}`, name: 'write_file', input: { path, content } };
}
function editFile(path: string): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}`, name: 'edit_file', input: { path, search: 'a', replace: 'b' } };
}

describe('applyIsolateRewriteNudge', () => {
  it('does not nudge the first write_file that creates a new file', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const mutated = applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb);
    expect(mutated).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  it('nudges on the second full overwrite of the same file', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb); // create
    const mutated = applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb); // rewrite
    expect(mutated).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect((state.messages[0].content as { text: string }[])[0].text).toMatch(/edit_file/);
    expect((state.messages[0].content as { text: string }[])[0].text).toContain('gui.py');
  });

  it('nudges on the FIRST write when the file was already read this run', () => {
    const state = stubLoopState();
    state.filesReadThisRun.add('gui.py');
    const cb = stubCallbacks();
    const mutated = applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb);
    expect(mutated).toBe(true);
  });

  it('matches read files by basename so relative/absolute paths still count', () => {
    const state = stubLoopState();
    state.filesReadThisRun.add('/abs/project/gui.py');
    const cb = stubCallbacks();
    const mutated = applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb);
    expect(mutated).toBe(true);
  });

  it('never nudges edit_file — that is the technique we want', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    applyIsolateRewriteNudge(state, [editFile('gui.py')], cb);
    const mutated = applyIsolateRewriteNudge(state, [editFile('gui.py')], cb);
    expect(mutated).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  it('stops nudging after the per-file cap so cycle detection takes over', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb); // count 1, create, no nudge
    expect(applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb)).toBe(true); // nudge 1
    expect(applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb)).toBe(true); // nudge 2
    expect(applyIsolateRewriteNudge(state, [writeFile('gui.py')], cb)).toBe(false); // capped
    expect(state.messages).toHaveLength(2);
  });

  it('tracks rewrite counts per file independently', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    applyIsolateRewriteNudge(state, [writeFile('a.py')], cb); // a: create
    applyIsolateRewriteNudge(state, [writeFile('b.py')], cb); // b: create
    expect(applyIsolateRewriteNudge(state, [writeFile('a.py')], cb)).toBe(true); // a: rewrite
    expect(state.fullRewriteCountByFile.get('a.py')).toBe(2);
    expect(state.fullRewriteCountByFile.get('b.py')).toBe(1);
  });

  it('handles file_path as well as path on the write input', () => {
    const state = stubLoopState();
    state.filesReadThisRun.add('gui.py');
    const cb = stubCallbacks();
    const tu: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-1',
      name: 'write_file',
      input: { file_path: 'gui.py', content: 'x' },
    };
    expect(applyIsolateRewriteNudge(state, [tu], cb)).toBe(true);
  });

  it('emits a short onText breadcrumb naming the file basenames', () => {
    const state = stubLoopState();
    state.filesReadThisRun.add('src/deep/gui.py');
    const cb = stubCallbacks();
    applyIsolateRewriteNudge(state, [writeFile('src/deep/gui.py')], cb);
    expect(cb.texts.join('')).toContain('gui.py');
    expect(cb.texts.join('')).not.toContain('src/deep');
  });

  it('ignores non-write tools entirely', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const read: ToolUseContentBlock = { type: 'tool_use', id: 'r', name: 'read_file', input: { path: 'gui.py' } };
    expect(applyIsolateRewriteNudge(state, [read], cb)).toBe(false);
  });
});
