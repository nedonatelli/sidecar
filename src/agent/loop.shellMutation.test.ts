import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentLoop } from './loop.js';
import { gitEnvForCwd } from './loop/treeSignature.js';
import { getConfig } from '../config/settings.js';
import type { StreamEvent } from '../ollama/types.js';
import type { SideCarClient } from '../ollama/client.js';
import type { AgentCallbacks } from './loop.js';

vi.mock('./tools.js', () => ({
  getToolDefinitions: () => [],
  getToolDefinitionsForTier: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

// #247: a run that edits only through the shell (`sed -i`, `cat > f`) used to
// leave state.fileMutations at 0, so the loop treated it as "before the first
// edit" for the whole run and #222's nudge fired where a stop was due. The run
// is observed through its own log line, written when the count moves.

const MUTATION_LINE = 'Working tree changed across a shell command; counted as a file mutation (#247)';
const callbacks: AgentCallbacks = { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onDone: () => {} };

let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-shellmut-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: gitEnvForCwd() });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

/** One run_command turn, then a text answer. The stand-in tool does `effect`. */
async function runWithShell(command: string, effect: () => void): Promise<string[]> {
  let turn = 0;
  const client = {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'c1', name: 'run_command', input: { command } } };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else {
        yield { type: 'text', text: 'done' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    },
    getSystemPrompt: () => '',
    getRouter: () => null,
    getModel: () => 'mock-model',
  } as unknown as SideCarClient;
  const shell = {
    definition: {
      name: 'run_command',
      description: 'run a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
    requiresApproval: false,
    executor: async () => {
      effect();
      return '(exit code: 0)';
    },
  };
  const lines: string[] = [];
  const logger = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => (key === 'info' ? (l: string) => lines.push(l) : () => {}),
  });
  await runAgentLoop(client, [{ role: 'user', content: 'fix src/a.py' }], callbacks, new AbortController().signal, {
    extraTools: [shell] as never,
    approvalMode: 'autonomous',
    maxIterations: 4,
    cwdOverride: repo,
    config: { ...getConfig(), completionGateEnabled: false },
    logger: logger as never,
  });
  return lines;
}

describe('a shell command that edits files counts as an edit (#247)', () => {
  it('`sed -i` on a tracked file', async () => {
    const lines = await runWithShell("sed -i 's/1/2/' src/a.py", () =>
      fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n'),
    );
    expect(lines).toContain(MUTATION_LINE);
  });

  it('`cat > src/a.py` overwriting a tracked file', async () => {
    const lines = await runWithShell('cat > src/a.py', () => fs.writeFileSync(path.join(repo, 'src/a.py'), 'y = 9\n'));
    expect(lines).toContain(MUTATION_LINE);
  });

  it('a scratch repro script (a new untracked file) does not count, so #222 still nudges', async () => {
    const lines = await runWithShell('cat <<EOF > reproduce_issue.py', () =>
      fs.writeFileSync(path.join(repo, 'reproduce_issue.py'), 'import x\n'),
    );
    expect(lines).not.toContain(MUTATION_LINE);
  });

  it('a read-only command does not count', async () => {
    const lines = await runWithShell('cat src/a.py', () => fs.readFileSync(path.join(repo, 'src/a.py')));
    expect(lines).not.toContain(MUTATION_LINE);
  });

  it('a test run writing only outside the repository does not count', async () => {
    const tmp = path.join(os.tmpdir(), `sidecar-shellmut-out-${process.pid}.txt`);
    const lines = await runWithShell('pytest --basetemp=/tmp/x', () => fs.writeFileSync(tmp, 'cache'));
    fs.rmSync(tmp, { force: true });
    expect(lines).not.toContain(MUTATION_LINE);
  });
});
