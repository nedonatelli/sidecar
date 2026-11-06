import { describe, it, expect, vi } from 'vitest';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import { applyStubCheck } from './stubCheck.js';
import type { LoopState } from './state.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import { mutated, failed } from '../tools/toolOutcome.js';

// ---------------------------------------------------------------------------
// Tests for stubCheck.ts (loop helper hardening).
//
// `applyStubCheck` composes `buildStubReprompt` from stubValidator.ts
// with the loop's retry-budget + state-mutation ceremony. The
// detection itself is separately covered by stubValidator.test.ts, so
// these tests focus on the helper's responsibilities:
//
//   1. Retry budget (MAX_STUB_RETRIES = 1) — second call returns false
//   2. Injects a user message when stubs are detected
//   3. Returns false when the content is clean (no stubs)
//   4. Bumps state.stubFixRetries on each injection
//   5. Surfaces a user-visible warning via callbacks.onText
//   6. Logs the attempt via state.logger when present
//   7. Checks only calls that changed a file (#161 ML-08)
// ---------------------------------------------------------------------------

function toolUseWriteFile(path: string, content: string): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}`, name: 'write_file', input: { path, content } };
}

/** Record that the call changed its file, as the executor does (ADR-008). */
function landed(state: LoopState, tu: ToolUseContentBlock): ToolUseContentBlock {
  state.toolOutcomes.set(tu.id, mutated(tu.input.path as string));
  return tu;
}

describe('applyStubCheck', () => {
  it('returns false when no stub patterns are found in the written content', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const clean = toolUseWriteFile(
      'src/real.ts',
      'export function add(a: number, b: number): number { return a + b; }',
    );
    expect(applyStubCheck(state, [clean], cb)).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.stubFixRetries).toBe(0);
  });

  it('returns true + injects a reprompt when a stub pattern is detected', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const stubbed = toolUseWriteFile('src/stub.ts', 'export function hello(): void {\n  // TODO: implement this\n}');
    expect(applyStubCheck(state, [landed(state, stubbed)], cb)).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect(state.stubFixRetries).toBe(1);
    expect(cb.texts[0]).toContain('Incomplete code');
  });

  it('refuses to inject a second reprompt — MAX_STUB_RETRIES=1 is a hard cap', () => {
    const state = stubLoopState({ stubFixRetries: 1 }); // already at the cap
    const cb = stubCallbacks();
    const stubbed = toolUseWriteFile('src/stub.ts', '// TODO: implement\nfunction x() {}');
    expect(applyStubCheck(state, [stubbed], cb)).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.stubFixRetries).toBe(1); // unchanged
  });

  it('logs the retry attempt via state.logger.info when present', () => {
    const info = vi.fn();
    const state = stubLoopState({ logger: { info, warn: vi.fn() } as unknown as LoopState['logger'] });
    const cb = stubCallbacks();
    const stubbed = toolUseWriteFile('src/stub.ts', '// TODO: implement\nfunction x() {}');
    applyStubCheck(state, [landed(state, stubbed)], cb);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('Stub validator');
    expect(info.mock.calls[0][0]).toContain('1/1');
  });

  it('silently returns false when there are no write_file / edit_file calls', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const readCall: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-read',
      name: 'read_file',
      input: { path: 'x.ts' },
    };
    expect(applyStubCheck(state, [readCall], cb)).toBe(false);
    expect(state.stubFixRetries).toBe(0);
  });

  it('handles edit_file with a stubbed replacement', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const edit: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-edit',
      name: 'edit_file',
      input: {
        path: 'src/broken.ts',
        search: 'return 0;',
        replace: '// TODO: finish this\nthrow new Error("not implemented");',
      },
    };
    expect(applyStubCheck(state, [landed(state, edit)], cb)).toBe(true);
    expect(state.stubFixRetries).toBe(1);
  });

  // A refused edit wrote nothing, so there is nothing to finish: 114 of the
  // 168 spurious reprompts in the recorded runs came from one (#161 ML-08).
  it.each([
    ['refused', (state: LoopState, tu: ToolUseContentBlock) => state.toolOutcomes.set(tu.id, failed('src/broken.ts'))],
    ['not recorded', () => undefined],
  ])('ignores an edit whose outcome is %s', (_label, record) => {
    const state = stubLoopState();
    const edit: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-edit',
      name: 'edit_file',
      input: { path: 'src/broken.ts', search: 'return 0;', replace: '// TODO: finish this\nreturn 0;' },
    };
    record(state, edit);
    expect(applyStubCheck(state, [edit], stubCallbacks())).toBe(false);
    expect(state.stubFixRetries).toBe(0);
  });
});
