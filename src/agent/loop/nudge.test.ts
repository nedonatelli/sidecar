import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { injectNudge, recordNudge, NUDGE_SOURCES } from './nudge.js';
import { summarizeDecisions, type AgentDecision } from '../decisions.js';
import type { ChatMessage } from '../../ollama/types.js';

function target(iteration = 3) {
  const decisions: AgentDecision[] = [];
  const messages: ChatMessage[] = [];
  return { decisions, messages, iteration, logger: { logDecision: (d: AgentDecision) => decisions.push(d) } };
}

describe('injectNudge', () => {
  it('pushes the message and records one reprompt decision', () => {
    const t = target();
    injectNudge(t, 'no-read', [{ type: 'text', text: 'Read src/a.py first.' }], ['src/a.py']);
    expect(t.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Read src/a.py first.' }] }]);
    expect(t.decisions).toEqual([
      {
        kind: 'reprompt',
        action: 'injected',
        source: 'no-read',
        iteration: 3,
        files: ['src/a.py'],
        text: 'Read src/a.py first.',
      },
    ]);
  });

  it('takes string content, keeps 200 characters, and leaves files out when there are none', () => {
    const t = target();
    injectNudge(t, 'whole-suite', 'x'.repeat(500), []);
    expect(t.messages[0].content).toBe('x'.repeat(500));
    expect(t.decisions[0].kind === 'reprompt' && t.decisions[0].text).toBe('x'.repeat(200));
    expect(t.decisions[0]).not.toHaveProperty('files');
  });

  it('records a nudge appended to an existing message', () => {
    const t = target(7);
    recordNudge(t, 'tool-call-parse', '[Tool call not parsed] ...');
    expect(t.decisions).toMatchObject([{ source: 'tool-call-parse', iteration: 7 }]);
  });

  it('is a no-op on the record side without a logger', () => {
    const messages: ChatMessage[] = [];
    injectNudge({ messages, iteration: 1 }, 'cycle-nudge', 'Act on it.');
    expect(messages).toHaveLength(1);
  });

  it('is counted per source in the run summary', () => {
    const t = target();
    injectNudge(t, 'no-read', 'a');
    injectNudge(t, 'no-read', 'b');
    injectNudge(t, 'no-file-write', 'c');
    expect(summarizeDecisions(t.decisions)).toMatchObject({
      'reprompt.injected': 3,
      'reprompt.source.no-read': 2,
      'reprompt.source.no-file-write': 1,
    });
  });
});

// Every nudge records exactly one decision because every nudge goes through
// injectNudge. These keep it that way: a new injection that pushes a user
// message directly fails the first test, and a source id nothing uses fails the
// second.
describe('every injection goes through injectNudge', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true }).flatMap((e) => {
      const rel = path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name);
      return e.isFile() && rel.endsWith('.ts') && !rel.endsWith('.test.ts') ? [rel] : [];
    });
  const files = [...sourceFiles('src/agent'), ...sourceFiles('bench')];
  const read = (f: string) => fs.readFileSync(f, 'utf8');

  // Not nudges: the tool-results turn, the sub-agent's first prompt, and this module.
  const ALLOWED = ['src/agent/loop/messageBuild.ts', 'src/agent/subagent.ts', 'src/agent/loop/nudge.ts'];

  it('no other code pushes a user message onto the conversation', () => {
    const offenders = files
      .filter((f) => !ALLOWED.some((a) => f.replace(/\\/g, '/').endsWith(a)))
      .filter((f) => /\bmessages\.push\(\s*\{\s*role:\s*'user'/.test(read(f)));
    expect(offenders.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))).toEqual([]);
  });

  it('every source id is used by an injection site', () => {
    const all = files.map(read).join('\n');
    const used = new Set<string>();
    for (const m of all.matchAll(/(?:injectNudge|recordNudge)\(\s*state,\s*([^,]+),/g)) {
      for (const lit of m[1].matchAll(/'([a-z-]+)'/g)) used.add(lit[1]);
    }
    // The reprompt gates pass their spec name, so their `name:` literals count.
    const gates = read(path.join(ROOT, 'src/agent/loop/completionGates/repromptGates.ts'));
    for (const m of gates.matchAll(/^\s+name: '([a-z-]+)',$/gm)) used.add(m[1]);
    expect(NUDGE_SOURCES.filter((s) => !used.has(s))).toEqual([]);
  });
});
