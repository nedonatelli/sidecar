import { describe, it, expect, vi } from 'vitest';
import { applyUnappliedEditNudge, hasEditShapedCodeBlock } from './unappliedEdit.js';
import { stubLoopState } from './testHelpers.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

const tu = (name: string, input: Record<string, unknown> = {}): ToolUseContentBlock => ({
  type: 'tool_use',
  id: `id-${name}`,
  name,
  input,
});

const callbacks = () => ({ onText: vi.fn() }) as unknown as AgentCallbacks;

const RUN = tu('run_command', { command: 'node src/stats.js' });
const JS_FIX =
  'Let me fix it:\n```javascript\nfunction avg(a){\n  return a.reduce((s,n)=>s+n,0)/a.length;\n}\n```\nNow re-run.';

describe('hasEditShapedCodeBlock', () => {
  it('detects a multi-line source-language fence', () => {
    expect(hasEditShapedCodeBlock(JS_FIX)).toBe(true);
    expect(hasEditShapedCodeBlock('```python\ndef f(x):\n    return x + 1\n```')).toBe(true);
  });

  // Every accepted fence language must be recognized — pins each entry of
  // CODE_FENCE_LANGS so dropping one is caught (a two-line body with structure).
  it.each([
    'javascript',
    'js',
    'jsx',
    'typescript',
    'ts',
    'tsx',
    'python',
    'py',
    'go',
    'rust',
    'rs',
    'java',
    'c',
    'cpp',
    'c++',
    'csharp',
    'cs',
    'ruby',
    'rb',
    'php',
    'swift',
    'kotlin',
    'scala',
  ])('recognizes the %s fence language', (lang) => {
    expect(hasEditShapedCodeBlock(`\`\`\`${lang}\nconst x = 1;\nreturn x;\n\`\`\``)).toBe(true);
  });

  // Each code-structure token alone (with a 2nd line) qualifies a block — pins
  // the CODE_STRUCTURE alternation so removing a branch is caught.
  it.each(['function', 'const', 'let', 'var', 'def', 'class', 'return', 'import', 'export', 'if', 'for', 'while'])(
    'treats the "%s" keyword as code structure',
    (kw) => {
      expect(hasEditShapedCodeBlock(`\`\`\`text\n${kw} something\nsecond line\n\`\`\``)).toBe(false); // wrong lang
      expect(hasEditShapedCodeBlock(`\`\`\`python\n${kw} something\nsecond line\n\`\`\``)).toBe(true);
    },
  );

  it.each(['=>', ';', '{', '}'])('treats the "%s" operator as code structure', (op) => {
    expect(hasEditShapedCodeBlock(`\`\`\`go\nfoo ${op} bar\nsecond line\n\`\`\``)).toBe(true);
  });

  it('requires at least two non-blank code lines (boundary)', () => {
    // One code line — not enough.
    expect(hasEditShapedCodeBlock('```js\nconst x = 1;\n```')).toBe(false);
    // Two — enough. Blank lines do not count toward the two.
    expect(hasEditShapedCodeBlock('```js\nconst x = 1;\n\n\nreturn x;\n```')).toBe(true);
  });

  it('a source-language fence with no code structure does not qualify', () => {
    // Two lines, right language, but no keyword/operator.
    expect(hasEditShapedCodeBlock('```python\nhello world\nsecond plain line\n```')).toBe(false);
  });

  it('ignores tool-call json fences and prose', () => {
    expect(hasEditShapedCodeBlock('```json\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```')).toBe(false);
    expect(hasEditShapedCodeBlock('Here is the plan in prose, no code fence at all.')).toBe(false);
    expect(hasEditShapedCodeBlock('```text\njust some notes\nacross two lines\n```')).toBe(false);
  });

  it('ignores a trivial one-line snippet', () => {
    expect(hasEditShapedCodeBlock('```js\nconsole.log(x)\n```')).toBe(false);
  });
});

describe('applyUnappliedEditNudge', () => {
  it('fires on the run-fix pattern: code block + verify tool + no mutation', () => {
    const state = stubLoopState();
    const cb = callbacks();
    const before = state.messages.length;
    expect(applyUnappliedEditNudge(state, [RUN], JS_FIX, cb)).toBe(true);
    expect(state.unappliedEditNudged).toBe(true);
    expect(state.messages.length).toBe(before + 1);
    const pushed = state.messages.at(-1)!;
    expect(pushed.role).toBe('user');
    expect(JSON.stringify(pushed.content)).toMatch(/edit_file or write_file/);
    expect(cb.onText).toHaveBeenCalled();
  });

  it('does NOT fire when the model actually applied an edit', () => {
    const state = stubLoopState();
    const cb = callbacks();
    // Code block present, but edit_file was called — the edit was applied.
    expect(applyUnappliedEditNudge(state, [tu('edit_file', { path: 'src/stats.js' }), RUN], JS_FIX, cb)).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  // Every mutation tool must suppress the nudge — pins each MUTATION_TOOLS entry
  // (paired with a verify tool + code block, which would otherwise fire).
  it.each([
    'write_file',
    'edit_file',
    'delete_file',
    'create_file',
    'rename_file',
    'move_file',
    'apply_edit',
    'apply_patch',
  ])('does NOT fire when %s applied a change this turn', (mutTool) => {
    const state = stubLoopState();
    expect(applyUnappliedEditNudge(state, [tu(mutTool, { path: 'src/stats.js' }), RUN], JS_FIX, callbacks())).toBe(
      false,
    );
    expect(state.messages).toHaveLength(0);
  });

  // Every verify tool must enable the nudge — pins each VERIFY_TOOLS entry.
  it.each([
    ['run_command', { command: 'node x.js' }],
    ['run_tests', {}],
    ['read_file', { path: 'src/stats.js' }],
    ['get_diagnostics', { path: 'src/stats.js' }],
  ] as const)('fires when the verify tool is %s (code block, no mutation)', (verifyTool, input) => {
    const state = stubLoopState();
    expect(applyUnappliedEditNudge(state, [tu(verifyTool, { ...input })], JS_FIX, callbacks())).toBe(true);
  });

  it('does NOT fire without a verify/execute tool (likely just explanation)', () => {
    const state = stubLoopState();
    // A code block plus only a grep — exploring, not verifying a phantom edit.
    expect(applyUnappliedEditNudge(state, [tu('grep', { query: 'avg' })], JS_FIX, callbacks())).toBe(false);
  });

  it('does NOT fire when there is no edit-shaped code block', () => {
    const state = stubLoopState();
    expect(applyUnappliedEditNudge(state, [RUN], 'The script fails because avg is NaN.', callbacks())).toBe(false);
  });

  it('fires at most once per run', () => {
    const state = stubLoopState();
    expect(applyUnappliedEditNudge(state, [RUN], JS_FIX, callbacks())).toBe(true);
    // Second identical occurrence — already nudged, so no-op.
    expect(applyUnappliedEditNudge(state, [RUN], JS_FIX, callbacks())).toBe(false);
    expect(state.messages).toHaveLength(1);
  });
});
