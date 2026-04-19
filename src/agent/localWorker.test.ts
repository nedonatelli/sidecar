import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for localWorker.ts (v0.65 chunk 6a).
//
// `runLocalWorker` spawns a subsidiary agent loop against the free
// local Ollama backend to offload read-only research from a paid
// orchestrator. The worker is deliberately crippled:
//   - read-only tool allowlist (no write_file; run_command allowed but filtered)
//   - approvalMode: 'autonomous' (no confirmations — can't cause damage)
//   - maxIterations capped by config (delegateTaskMaxIterations)
//   - worker tokens don't count against the paid budget
//
// These tests pin the guardrails: the allowlist filter, the iteration
// cap (min of caller-passed + config cap), the system-prompt override,
// parent-callback forwarding (prefixed with "worker:"), and success /
// failure result shapes.
// ---------------------------------------------------------------------------

const { runAgentLoopMock, SideCarClientMock, createdClients } = vi.hoisted(() => {
  const createdClients: Array<{ model: string; baseUrl: string; systemPrompt: string | null }> = [];
  class SideCarClientStub {
    model: string;
    baseUrl: string;
    systemPrompt: string | null = null;
    constructor(model: string, baseUrl: string, _provider: string) {
      this.model = model;
      this.baseUrl = baseUrl;
      createdClients.push({ model, baseUrl, systemPrompt: null });
    }
    updateSystemPrompt(p: string) {
      this.systemPrompt = p;
      const last = createdClients[createdClients.length - 1];
      if (last) last.systemPrompt = p;
    }
  }
  return {
    runAgentLoopMock: vi.fn(),
    SideCarClientMock: SideCarClientStub,
    createdClients,
  };
});

vi.mock('../ollama/client.js', () => ({
  SideCarClient: SideCarClientMock,
}));

vi.mock('../config/settings.js', () => ({
  getConfig: () => ({
    model: 'qwen2.5-coder:7b',
    delegateTaskWorkerModel: '',
    delegateTaskWorkerBaseUrl: '',
    delegateTaskMaxIterations: 5,
  }),
}));

vi.mock('./loop.js', () => ({
  runAgentLoop: runAgentLoopMock,
}));

vi.mock('./tools.js', () => ({
  getToolDefinitions: vi.fn().mockReturnValue([
    { name: 'read_file', description: '', input_schema: { type: 'object' } },
    { name: 'write_file', description: '', input_schema: { type: 'object' } },
    { name: 'grep', description: '', input_schema: { type: 'object' } },
    { name: 'run_command', description: '', input_schema: { type: 'object' } },
    { name: 'delete_file', description: '', input_schema: { type: 'object' } },
    { name: 'list_directory', description: '', input_schema: { type: 'object' } },
    { name: 'delegate_task', description: '', input_schema: { type: 'object' } }, // intentionally blocked
  ]),
}));

import { runLocalWorker, isWorkerSafeCommand } from './localWorker.js';
import type { AgentCallbacks } from './loop.js';

function makeParentCallbacks(): AgentCallbacks & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    onText: (t: string) => texts.push(t),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

beforeEach(() => {
  runAgentLoopMock.mockReset();
  createdClients.length = 0;
});

describe('runLocalWorker — success path', () => {
  it('returns trimmed output + success=true when runAgentLoop resolves cleanly', async () => {
    runAgentLoopMock.mockImplementation(async (_client, _msgs, cb) => {
      cb.onText('SUMMARY\n=======\nTask: x\n');
      cb.onText('Findings: ok\n');
      cb.onDone();
    });
    const result = await runLocalWorker(
      'investigate auth',
      undefined,
      makeParentCallbacks(),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('SUMMARY');
    expect(result.output).not.toMatch(/^\s|\s$/); // trimmed
    expect(result.model).toBe('qwen2.5-coder:7b');
  });

  it('emits a start breadcrumb + completion breadcrumb on the parent callbacks', async () => {
    runAgentLoopMock.mockImplementation(async (_client, _msgs, cb) => {
      cb.onText('done');
      cb.onDone();
    });
    const cb = makeParentCallbacks();
    await runLocalWorker('investigate auth', undefined, cb, new AbortController().signal);
    const joined = cb.texts.join('');
    expect(joined).toMatch(/delegate_task → local worker/);
    expect(joined).toMatch(/delegate_task completed/);
  });

  it('accumulates charsConsumed from onCharsConsumed callbacks', async () => {
    runAgentLoopMock.mockImplementation(async (_client, _msgs, cb) => {
      cb.onCharsConsumed?.(100);
      cb.onCharsConsumed?.(50);
      cb.onText('x');
      cb.onDone();
    });
    const result = await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(result.charsConsumed).toBe(150);
  });

  it('replaces empty output with a placeholder message so the tool_result is never blank', async () => {
    runAgentLoopMock.mockImplementation(async (_client, _msgs, cb) => {
      cb.onDone();
    });
    const result = await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(result.output).toBe('(worker produced no output)');
    expect(result.success).toBe(true);
  });
});

describe('runLocalWorker — context + prompt shape', () => {
  it('includes context in the user prompt when supplied', async () => {
    let capturedPrompt = '';
    runAgentLoopMock.mockImplementation(async (_client, messages, cb) => {
      capturedPrompt = messages[0].content as string;
      cb.onDone();
    });
    await runLocalWorker('do X', 'prior context here', makeParentCallbacks(), new AbortController().signal);
    expect(capturedPrompt).toContain('Context from orchestrator');
    expect(capturedPrompt).toContain('prior context here');
    expect(capturedPrompt).toContain('Task: do X');
  });

  it('omits the context preamble when context is undefined', async () => {
    let capturedPrompt = '';
    runAgentLoopMock.mockImplementation(async (_client, messages, cb) => {
      capturedPrompt = messages[0].content as string;
      cb.onDone();
    });
    await runLocalWorker('solo task', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(capturedPrompt).not.toContain('Context from orchestrator');
    expect(capturedPrompt.startsWith('Task: solo task')).toBe(true);
  });
});

describe('runLocalWorker — tool allowlist', () => {
  it('passes toolOverride with ONLY read-only tools (no write_file, delete_file, delegate_task) + filtered run_command', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    const options = runAgentLoopMock.mock.calls[0][4];
    const toolNames = (options.toolOverride as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('list_directory');
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).toContain('run_command'); // Allowed but filtered via commandFilter
    expect(toolNames).not.toContain('delete_file');
    expect(toolNames).not.toContain('delegate_task');
  });

  it('sets modeToolPermissions to "allow" for every allowlisted tool (autonomous mode)', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    const options = runAgentLoopMock.mock.calls[0][4];
    const perms = options.modeToolPermissions as Record<string, string>;
    expect(perms.read_file).toBe('allow');
    expect(perms.grep).toBe('allow');
    // Blocked tools should not be in the map at all.
    expect(perms.write_file).toBeUndefined();
  });
});

describe('runLocalWorker — maxIterations cap', () => {
  it('uses the config cap when caller passes no maxIterations', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(runAgentLoopMock.mock.calls[0][4].maxIterations).toBe(5);
  });

  it('honors a caller override LOWER than the cap', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal, { maxIterations: 3 });
    expect(runAgentLoopMock.mock.calls[0][4].maxIterations).toBe(3);
  });

  it('enforces the cap even when caller passes a larger maxIterations', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal, { maxIterations: 100 });
    expect(runAgentLoopMock.mock.calls[0][4].maxIterations).toBe(5);
  });
});

describe('runLocalWorker — approval + depth', () => {
  it('forces approvalMode: "autonomous" regardless of caller intent', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal, {
      approvalMode: 'cautious',
    });
    expect(runAgentLoopMock.mock.calls[0][4].approvalMode).toBe('autonomous');
  });

  it('increments depth by 1 (defaults to 1 if caller omits depth)', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(runAgentLoopMock.mock.calls[0][4].depth).toBe(1);
  });

  it('increments a caller-supplied depth', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal, { depth: 2 });
    expect(runAgentLoopMock.mock.calls[0][4].depth).toBe(3);
  });
});

describe('runLocalWorker — client configuration', () => {
  it('instantiates a fresh SideCarClient with the worker model + default Ollama baseUrl', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => cb.onDone());
    await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(createdClients).toHaveLength(1);
    expect(createdClients[0].model).toBe('qwen2.5-coder:7b');
    expect(createdClients[0].baseUrl).toBe('http://localhost:11434');
    expect(createdClients[0].systemPrompt).toMatch(/local research worker/);
  });
});

describe('runLocalWorker — worker callback prefixing', () => {
  it('forwards tool calls to the parent with a "worker:" name prefix', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => {
      cb.onToolCall('read_file', { path: 'a.ts' }, 'tu1');
      cb.onToolResult('read_file', 'content', false, 'tu1');
      cb.onDone();
    });
    const parent = makeParentCallbacks();
    await runLocalWorker('x', undefined, parent, new AbortController().signal);
    expect(parent.onToolCall).toHaveBeenCalledWith('worker:read_file', { path: 'a.ts' }, 'tu1');
    expect(parent.onToolResult).toHaveBeenCalledWith('worker:read_file', 'content', false, 'tu1');
  });
});

describe('runLocalWorker — failure path', () => {
  it('returns success=false with the error message when runAgentLoop throws', async () => {
    runAgentLoopMock.mockRejectedValue(new Error('Ollama unreachable'));
    const parent = makeParentCallbacks();
    const result = await runLocalWorker('x', undefined, parent, new AbortController().signal);
    expect(result.success).toBe(false);
    expect(result.output).toBe('Ollama unreachable');
    expect(parent.texts.join('')).toContain('delegate_task failed: Ollama unreachable');
  });

  it('preserves charsConsumed accumulated before the failure', async () => {
    runAgentLoopMock.mockImplementation(async (_c, _m, cb) => {
      cb.onCharsConsumed?.(75);
      throw new Error('mid-run crash');
    });
    const result = await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(result.success).toBe(false);
    expect(result.charsConsumed).toBe(75);
  });

  it('coerces non-Error throws to strings', async () => {
    runAgentLoopMock.mockRejectedValue('string rejection');
    const result = await runLocalWorker('x', undefined, makeParentCallbacks(), new AbortController().signal);
    expect(result.success).toBe(false);
    expect(result.output).toBe('string rejection');
  });
});

describe('isWorkerSafeCommand', () => {
  it('allows common read-only commands', () => {
    expect(isWorkerSafeCommand('cat README.md')).toBe(true);
    expect(isWorkerSafeCommand('head -20 src/main.ts')).toBe(true);
    expect(isWorkerSafeCommand('tail -f logs/app.log')).toBe(true);
    expect(isWorkerSafeCommand('grep -rn TODO src/')).toBe(true);
    expect(isWorkerSafeCommand('find . -name "*.ts"')).toBe(true);
    expect(isWorkerSafeCommand('ls -la')).toBe(true);
    expect(isWorkerSafeCommand('tree src/')).toBe(true);
    expect(isWorkerSafeCommand('wc -l *.ts')).toBe(true);
    expect(isWorkerSafeCommand('jq .name package.json')).toBe(true);
    expect(isWorkerSafeCommand("awk '{print $1}' file.txt")).toBe(true);
    expect(isWorkerSafeCommand('git log --oneline -5')).toBe(true);
    expect(isWorkerSafeCommand('npm ls')).toBe(true);
  });

  it('allows pwd and env without arguments', () => {
    expect(isWorkerSafeCommand('pwd')).toBe(true);
    expect(isWorkerSafeCommand('env')).toBe(true);
    expect(isWorkerSafeCommand('date')).toBe(true);
  });

  it('rejects destructive commands', () => {
    expect(isWorkerSafeCommand('rm file.txt')).toBe(false);
    expect(isWorkerSafeCommand('rm -rf /')).toBe(false);
    expect(isWorkerSafeCommand('mv a.txt b.txt')).toBe(false);
    expect(isWorkerSafeCommand('cp src dest')).toBe(false);
    expect(isWorkerSafeCommand('chmod 755 script.sh')).toBe(false);
    expect(isWorkerSafeCommand('npm install')).toBe(false);
    expect(isWorkerSafeCommand('npm run build')).toBe(false);
    expect(isWorkerSafeCommand('node script.js')).toBe(false);
  });

  it('rejects output redirection', () => {
    expect(isWorkerSafeCommand('cat file.txt > output.txt')).toBe(false);
    expect(isWorkerSafeCommand('echo hello >> log.txt')).toBe(false);
    expect(isWorkerSafeCommand('grep foo bar.txt > result')).toBe(false);
  });

  it('allows 2>&1 stderr redirection', () => {
    expect(isWorkerSafeCommand('cat file.txt 2>&1')).toBe(true);
    expect(isWorkerSafeCommand('grep foo bar 2>&1')).toBe(true);
  });

  it('rejects pipes to dangerous commands', () => {
    expect(isWorkerSafeCommand('cat file | sh')).toBe(false);
    expect(isWorkerSafeCommand('echo "rm -rf" | bash')).toBe(false);
    expect(isWorkerSafeCommand('cat script | xargs rm')).toBe(false);
    expect(isWorkerSafeCommand('find . | xargs chmod')).toBe(false);
  });

  it('allows pipes to safe commands', () => {
    expect(isWorkerSafeCommand('cat file | grep foo')).toBe(true);
    expect(isWorkerSafeCommand('ls | head -5')).toBe(true);
    expect(isWorkerSafeCommand('find . -name "*.ts" | wc -l')).toBe(true);
  });

  it('rejects curl with output flags', () => {
    expect(isWorkerSafeCommand('curl -o file.txt http://example.com')).toBe(false);
    expect(isWorkerSafeCommand('curl --output file.txt http://example.com')).toBe(false);
    expect(isWorkerSafeCommand('curl -O http://example.com/file.zip')).toBe(false);
  });

  it('allows curl for simple fetching', () => {
    expect(isWorkerSafeCommand('curl http://example.com')).toBe(true);
    expect(isWorkerSafeCommand('curl -s http://api.example.com/data')).toBe(true);
  });

  it('rejects command substitution with dangerous content', () => {
    expect(isWorkerSafeCommand('cat $(find . -name "*.txt")')).toBe(false);
    expect(isWorkerSafeCommand('echo $(rm -rf /)')).toBe(false);
  });
});
