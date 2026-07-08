import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MCPManager } from '../../src/agent/mcpManager.js';
import { runAgentCase, AGENT_BACKENDS } from './agentHarness.js';
import type { AgentEvalCase } from './agentTypes.js';

const ollamaBackend = AGENT_BACKENDS.ollama;

// ---------------------------------------------------------------------------
// Live MCP probe — exercises the v0.117 context-economy features against a
// REAL MCP server (@modelcontextprotocol/server-memory via npx) and a real
// local model:
//
//   1. Lazy schema loading: the catalog carries one-line stubs for MCP tools;
//      does the model fetch the schema via describe_tool (or recover via the
//      schema-on-error hint) before/after using one?
//   2. Mutation-verify gate: after an external write, does a read-back happen
//      (self-driven or gate-driven) before the agent finishes?
//
// Opt-in: requires a network-fetched server + a local model, so it runs only
// with SIDECAR_EVAL_MCP=1. The primary artifact is the trajectory dump
// (mcp-live-<case>.json next to the suite log) — read it, don't just trust
// pass/fail (CONTRIBUTING: read trajectories).
//
//   SIDECAR_EVAL_MCP=1 npx vitest run --config vitest.eval.config.ts tests/llm-eval/mcpLive.eval.ts
// ---------------------------------------------------------------------------

const enabled = process.env.SIDECAR_EVAL_MCP === '1';
const d = enabled ? describe : describe.skip;

const TRAJECTORY_DIR = process.env.SIDECAR_EVAL_TRAJECTORY_DIR || os.tmpdir();

d('llm-eval :: live MCP probe (memory server)', () => {
  const manager = new MCPManager();
  let memoryFile: string;

  beforeAll(async () => {
    memoryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-live-')), 'memory.json');
    await manager.connect({
      memory: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        env: { MEMORY_FILE_PATH: memoryFile },
      },
    });
    if (!manager.isServerConnected('memory')) {
      throw new Error('memory MCP server failed to connect — is npx available/network up?');
    }
  }, 120_000);

  afterAll(async () => {
    await manager.disconnect();
  });

  it('creates an entity via a lazy-stubbed MCP mutation and verifies it before finishing', async () => {
    const evalCase: AgentEvalCase = {
      id: 'mcp-live-create-verify',
      description: 'Lazy MCP stub → schema fetch → mutation → read-back verification',
      tags: ['mcp', 'live'],
      workspace: {},
      mcpManager: manager,
      maxIterations: 12,
      userMessage:
        "Using the MCP memory server tools, create an entity named 'dogfood-probe' with entityType 'test' " +
        "and one observation: 'created during the v0.117 live probe'. Make sure it was actually stored, " +
        'then tell me exactly what was stored.',
      expect: {
        // The mutation must happen…
        toolsCalled: ['mcp_memory_create_entities'],
        // …and SOME read-back must confirm it (self-driven or driven by the
        // mutation-verify gate — either path satisfies the discipline).
        toolsCalledAny: ['mcp_memory_read_graph', 'mcp_memory_search_nodes', 'mcp_memory_open_nodes'],
      },
      softExpect: {
        finalTextContains: ['dogfood-probe'],
      },
    };

    const result = await runAgentCase(evalCase, ollamaBackend, undefined, 'qwen2.5-coder:7b');

    const dump = path.join(TRAJECTORY_DIR, 'mcp-live-create-verify.json');
    fs.writeFileSync(dump, JSON.stringify(result, null, 2));
    console.log(`[mcp-live] trajectory → ${dump}`);
    console.log(`[mcp-live] passed=${result.passed} failures=${JSON.stringify(result.failures)}`);

    // Hard gate mirrors T2: infra must be clean even if the model wobbles.
    const infra = result.failures.filter((f) => /Unknown tool|runAgentLoop threw/.test(f));
    expect(infra).toEqual([]);
    expect(result.passed).toBe(true);

    // The external write really landed: the server's persistence file has it.
    const stored = fs.readFileSync(memoryFile, 'utf8');
    expect(stored).toContain('dogfood-probe');
  });

  it('a silent external write still gets read back before the agent finishes (gate-or-self-verify)', async () => {
    const evalCase: AgentEvalCase = {
      id: 'mcp-live-silent-write',
      description: 'Write-only task — the mutation-verify discipline must still produce a read-back',
      tags: ['mcp', 'live'],
      workspace: {},
      mcpManager: manager,
      maxIterations: 12,
      // Deliberately does NOT ask for confirmation — if the model doesn't
      // read back on its own, the completion gate must demand it.
      userMessage:
        "Using the MCP memory server tools, add an entity named 'silent-write-probe' with entityType 'test' " +
        "and observation 'gate probe'. Nothing else.",
      expect: {
        toolsCalled: ['mcp_memory_create_entities'],
      },
      // Soft: the read-back is the discipline's goal, but on a bail (cycle /
      // iteration cap) the gate never gets a natural-termination point to
      // fire at, so a thrashing model can end write-only without the gate
      // being wrong. Gate mechanics are pinned deterministically in
      // completionGate.test.ts / gate.test.ts; this case observes the live
      // trajectory (read the dump) rather than hard-failing on model wobble.
      softExpect: {
        toolsCalledAny: ['mcp_memory_read_graph', 'mcp_memory_search_nodes', 'mcp_memory_open_nodes'],
      },
    };

    const result = await runAgentCase(evalCase, ollamaBackend, undefined, 'qwen2.5-coder:7b');

    const dump = path.join(TRAJECTORY_DIR, 'mcp-live-silent-write.json');
    fs.writeFileSync(dump, JSON.stringify(result, null, 2));
    const gateFired = result.trajectory.some(
      (e) => e.type === 'text' && e.text.includes('Verifying external writes'),
    );
    console.log(`[mcp-live] trajectory → ${dump}`);
    console.log(`[mcp-live] passed=${result.passed} gateFired=${gateFired} failures=${JSON.stringify(result.failures)}`);

    const infra = result.failures.filter((f) => /Unknown tool|runAgentLoop threw/.test(f));
    expect(infra).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('answers a read-only question through lazy-stubbed MCP tools without tripping the mutation gate', async () => {
    const evalCase: AgentEvalCase = {
      id: 'mcp-live-read-only',
      description: 'Lazy MCP stubs on a pure read workflow — no false mutation-verify reprompt',
      tags: ['mcp', 'live'],
      workspace: {},
      mcpManager: manager,
      maxIterations: 10,
      userMessage:
        'Using the MCP memory server tools, tell me which entities currently exist in the knowledge graph. ' +
        'Just read — do not create or modify anything.',
      expect: {
        toolsCalledAny: ['mcp_memory_read_graph', 'mcp_memory_search_nodes', 'mcp_memory_open_nodes'],
        toolsNotCalled: ['mcp_memory_create_entities', 'mcp_memory_delete_entities'],
      },
    };

    const result = await runAgentCase(evalCase, ollamaBackend, undefined, 'qwen2.5-coder:7b');

    const dump = path.join(TRAJECTORY_DIR, 'mcp-live-read-only.json');
    fs.writeFileSync(dump, JSON.stringify(result, null, 2));
    console.log(`[mcp-live] trajectory → ${dump}`);
    console.log(`[mcp-live] passed=${result.passed} failures=${JSON.stringify(result.failures)}`);

    const infra = result.failures.filter((f) => /Unknown tool|runAgentLoop threw/.test(f));
    expect(infra).toEqual([]);
    // The false-positive the read-verb fallback exists to prevent: a pure
    // read run must not end with the mutation-verify reprompt in history.
    const gateFired = result.trajectory.some(
      (e) => e.type === 'text' && e.text.includes('Unverified external write'),
    );
    expect(gateFired).toBe(false);
    expect(result.passed).toBe(true);
  });
});
