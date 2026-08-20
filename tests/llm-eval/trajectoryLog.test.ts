import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTrajectoryLogger } from './trajectoryLog.js';
import type { EffectiveSurface } from './agentHarness.js';

type CB = {
  onThinking?: (t: string) => void;
  onText?: (t: string) => void;
  onToolCall?: (n: string, i: Record<string, unknown>, id: string) => void;
  onToolResult?: (n: string, r: string, e: boolean, id: string) => void;
};

const surface: EffectiveSurface = {
  systemPromptChars: 26095,
  systemPromptHash: 'abc123',
  toolNames: ['edit_file', 'grep', 'project_knowledge_search', 'read_file'],
  toolCatalogHash: 'def456',
  ragOrientationChars: 0,
  seed: 1000,
  temperature: 0,
  numCtx: 32768,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajlog-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (p: string): string => fs.readFileSync(p, 'utf-8');

describe('trajectory logger', () => {
  const make = () =>
    createTrajectoryLogger({
      dir,
      caseId: 'c1',
      arm: 'bare',
      seed: 1000,
      trial: 2,
      surface,
      configOverrides: { completionGateEnabled: false },
    });

  it('writes what was ON before any event happens', () => {
    // The failure this prevents: describing an arm by its intended config.
    const l = make();
    const head = read(l.logPath);
    expect(head).toMatch(/arm=bare \| seed=1000 \| trial=2/);
    expect(head).toMatch(/system_prompt: 26095 chars \(abc123\)/);
    expect(head).toMatch(/project_knowledge_search/); // catalog membership is stated, not remembered
    expect(head).toMatch(/rag_orientation: 0 chars \(did not fire\)/);
    expect(head).toMatch(/completionGateEnabled/);
  });

  it('records thinking in full rather than truncated', () => {
    const l = make();
    const long = 'x'.repeat(5000);
    const cb = l.wrap<CB>({});
    cb.onThinking?.(long);
    l.close('natural'); // buffered until a flush point
    expect(read(l.logPath)).toContain(long);
  });

  it('buffers streamed thinking into ONE entry instead of one per token', () => {
    // onThinking fires token-by-token: a single live run produced 2,383 entries
    // of 3-7 chars each, burying the tool calls it was meant to explain.
    const l = make();
    const cb = l.wrap<CB>({});
    for (const tok of ['The ', 'user ', 'wants ', 'to ', 'fix ', 'it.']) cb.onThinking?.(tok);
    cb.onToolCall?.('read_file', { path: 'a.py' }, 'id'); // flush point
    const body = read(l.logPath);
    expect(body.match(/THINKING \(/g) ?? []).toHaveLength(1);
    expect(body).toContain('The user wants to fix it.');
  });

  it('tags gate and reprompt firings so they are greppable', () => {
    const l = make();
    const cb = l.wrap<CB>({});
    cb.onText?.('⚠️ Agent stopped: the exact same edit_file call was submitted 3 times.');
    cb.onToolCall?.('grep', {}, 'flush1');
    cb.onText?.('ordinary streamed prose that is not a scaffold event');
    l.close('natural');
    const body = read(l.logPath);
    expect(body).toMatch(/SCAFFOLD \[⚠️\].*Agent stopped/);
    expect(body).not.toMatch(/ordinary streamed prose/);
  });

  it('flushes each event immediately so a killed run keeps its tail', () => {
    // Lid close and per-case timeouts both killed runs tonight; a buffered
    // writer loses exactly the part you need.
    const l = make();
    const cb = l.wrap<CB>({});
    cb.onToolCall?.('edit_file', { path: 'a.py' }, 'id1');
    expect(read(l.logPath)).toMatch(/TOOL edit_file/); // present BEFORE close()
  });

  it('chains to the original callbacks instead of replacing them', () => {
    const seen: string[] = [];
    const l = make();
    const cb = l.wrap<CB>({ onToolCall: (n: string) => seen.push(n) });
    cb.onToolCall?.('grep', {}, 'id');
    expect(seen).toEqual(['grep']);
  });

  it('writes a machine-readable sibling for analysis', () => {
    const l = make();
    l.wrap<CB>({}).onToolResult?.('read_file', 'contents', false, 'id');
    l.close('natural');
    const jsonl = read(l.logPath.replace(/\.log$/, '.jsonl'))
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    expect(jsonl[0].type).toBe('header');
    expect(jsonl.some((e) => e.type === 'tool_result' && e.name === 'read_file')).toBe(true);
    expect(jsonl.at(-1)).toMatchObject({ type: 'termination', termination: 'natural' });
  });
});
