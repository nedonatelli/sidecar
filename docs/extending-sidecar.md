# Extending SideCar

Five extension surfaces — ordered by increasing power and increasing trust requirement:

1. **[Skills](#skills)** — markdown prompt fragments that inject into the system prompt when triggered. No code; no approval gate needed (content is just more text for the model). Best for: coding conventions, domain context, command templates.
2. **[Facets](#facets)** — *(new in v0.66)* named sub-agents with their own tool allowlist, preferred model, and system prompt. Dispatched as specialists via `SideCar: Facets: Dispatch Specialists` and run in isolated Shadow Workspaces. Best for: role-scoped work like test authoring, security review, or DSP design, especially when you want a different model per role.
3. **[Custom tools](#custom-tools)** — user-defined shell commands surfaced to the agent as callable tools. Simple to author, full shell privileges, always requires approval per call. Best for: internal CLIs, build / deploy wrappers, project-specific scripts.
4. **[MCP servers](#mcp-servers)** — external processes or HTTP endpoints that expose tools via the Model Context Protocol. SDK-based; own lifecycle. Best for: integrating with GitHub / Linear / Postgres / custom data sources, or any tool you want to share across Claude Code + SideCar + other MCP clients.
5. **[Policy hooks](#policy-hooks)** — TypeScript-level extension of the agent loop's `HookBus`. Full access to loop state; runs in-process. Best for: custom completion gates, domain-specific validators, regression guards.

| Surface | Authoring effort | Trust required | Sharable across clients |
| --- | --- | --- | --- |
| Skill | Minimal (markdown) | Workspace trust for project-local skills | ✅ (Claude Code compatible) |
| Facet | Low (markdown + YAML frontmatter) | Workspace trust for project-local facets | ❌ SideCar-specific |
| Custom tool | Low (one shell command + JSON schema) | Per-call approval + workspace trust | ❌ SideCar-specific |
| MCP server | Medium (separate codebase + SDK) | Workspace trust for stdio transport | ✅ (any MCP client) |
| Policy hook | High (TypeScript, in-process) | Only shipped via the extension's own code or a fork | ❌ SideCar-specific |

Pick the lowest-power option that covers your use case.

## Skills

A skill is a markdown file with optional YAML frontmatter. When the user types `/<skill-name>` in chat, the skill's content gets injected into the system prompt for that turn.

### File locations

Scanned in order (later sources override earlier on name conflict):

1. `<extension>/skills/*.md` — built-in defaults
2. `~/.claude/commands/*.md` — user-level (Claude Code compatible)
3. `<workspace>/.claude/commands/*.md` — project-level (Claude Code compatible)
4. `<workspace>/.sidecar/skills/*.md` — SideCar native project skills

Workspace-sourced skills (sources 3 + 4) that shadow a built-in or user skill log a warning on load, because a cloned repo could ship a malicious `/review-code` that silently replaces the expected one.

### Schema

```markdown
---
name: Review Code
description: Triggers a thorough code review with security + perf focus
---

You are reviewing code for production readiness.

Focus on:
- Security (injection, auth bypass, secret handling)
- Performance (N+1 queries, quadratic algorithms)
- Correctness (off-by-one, null handling, error paths)

Output format: bullet list grouped by severity.
```

- `name` + `description` are from YAML frontmatter. Both optional; default to the filename.
- Content below the frontmatter is the prompt body. Anything goes — plain prose, code examples, JSON templates.
- Claude Code skill fields (`allowed-tools`, `disable-model-invocation`) are parsed-but-ignored for compatibility.

### Trust semantics

When the active workspace isn't trusted, skills from sources 3 + 4 (project-level) are not loaded at all. Trusted workspace + workspace-sourced skill injects with a provenance banner telling the LLM to treat the skill's instructions as untrusted data — same policy as MCP tool output.

See [`src/agent/skillLoader.ts`](../src/agent/skillLoader.ts) for the loader implementation and [`docs/slash-commands.md`](slash-commands.md) for user-level docs.

## Facets

*New in v0.66.* A facet is a named specialist — a display name, preferred model, tool allowlist, system prompt, optional dependency graph, optional RPC schema. The user dispatches one or more facets against a shared task via `SideCar: Facets: Dispatch Specialists` in the Command Palette; each one runs in its own isolated Shadow Workspace with its own allowed toolset, and the resulting diffs are collected into a single aggregated review flow at the end.

Facets are distinct from Skills: a skill injects text into the system prompt for the main agent turn, while a facet spawns a new agent run with its own context, shadow worktree, and tool permissions. Pick a facet when you want the specialist's boundary enforced — it can only call the tools you grant it, its writes only land in its shadow, its model is what you picked — not just "I want a different voice in the prompt."

### File locations

Scanned in order (later sources override earlier on id collision):

1. **Built-in catalog** — 8 specialists shipped embedded in SideCar itself: `general-coder`, `latex-writer`, `signal-processing`, `frontend`, `test-author`, `technical-writer`, `security-reviewer`, `data-engineer`. Not loaded from disk — avoids a broken-unpack footgun.
2. `<workspace>/.sidecar/facets/*.md` — project-local facets.
3. Paths listed in `sidecar.facets.registry` (user setting) — personal or team facets checked into a separate repo.

### Schema

```markdown
---
id: api-contract-tester
displayName: API Contract Tester
preferredModel: claude-haiku-4-5
toolAllowlist: ["read_file", "grep", "run_tests", "edit_file", "write_file"]
dependsOn: []
rpcSchema:
  review:
    description: Review a proposed endpoint change for contract breaks
    input: { type: object, properties: { path: { type: string } } }
    output: { type: object, properties: { findings: { type: array } } }
---

You are an API contract tester. For every change to a route handler, diff
the OpenAPI schema, assert backward compatibility, and generate contract
tests that would fail if the breaking change shipped unreviewed.
```

- `id` + `displayName` + `systemPrompt` body are required.
- `toolAllowlist` is an array of tool names — the facet sees exactly those tools (plus any RPC tools generated from peer facets' `rpcSchema`).
- `preferredModel` is pinned via `client.setTurnOverride` for the duration of the facet's run, then restored.
- `dependsOn` is an array of other facet ids — the dispatcher walks the resulting DAG in topological order, so a facet with `dependsOn: ["general-coder"]` only starts after `general-coder` finishes.
- `rpcSchema` declares methods this facet answers. Other facets in the same batch get auto-generated `rpc.<this-facet-id>.<method>` tools they can call; the bus never rejects — calls resolve to `{ ok: true, value }` or `{ ok: false, errorKind: 'no-handler' | 'timeout' | 'handler-threw', message }`.

### Dispatch model

`dispatchFacets(client, registry, ids, callbacks, { task, maxConcurrent, rpcTimeoutMs, rpcHandlers })` walks the registry's topological layers with bounded parallelism (`sidecar.facets.maxConcurrent`, default 3). Each facet:

1. Pins its `preferredModel`, composes its system prompt on top of the orchestrator's, filters tools to its allowlist.
2. Runs a full agent loop inside a fresh Shadow Workspace (`forceShadow: true, deferPrompt: true`).
3. Captures its final diff into `SandboxResult.pendingDiff` instead of prompting mid-run — so a 5-facet batch doesn't fire 5 overlapping quickpicks.

After all facets settle, a single review UI (`reviewFacetBatch`) walks the batch: per-facet Accept / Show diff / Reject / Skip, cross-facet file-overlap warnings, `git apply` on accepted entries. Unaccepted facets' shadows are discarded; they never touched the main tree.

### Trust semantics

When the active workspace isn't trusted, project-local facets (source 2) are not loaded. Built-ins and `sidecar.facets.registry` paths (source 3) are still available. Disk-facet parse errors per-file never abort the load — the dispatcher always has the built-in catalog as a floor, so registry-level failures (cycles, unknown dependencies across disk facets) fall back to built-ins only rather than surfacing an empty specialist list.

### Config

- `sidecar.facets.enabled` (default `true`) — master toggle. When off, the dispatch command shows a one-line info toast instead of the picker.
- `sidecar.facets.maxConcurrent` (default `3`, clamped 1–16) — per-layer parallelism cap.
- `sidecar.facets.rpcTimeoutMs` (default `30000`, clamped 1000–300000) — per-RPC call timeout. Timeouts surface as `{ ok: false, errorKind: 'timeout' }` and the call resolves; the facet never hangs on a peer.
- `sidecar.facets.registry` (default `[]`) — array of absolute paths to additional facet `.md` files.

See [`src/agent/facets/`](../src/agent/facets/) for the implementation, particularly `facetLoader.ts` (schema + built-ins), `facetRegistry.ts` (validation + layering), `facetDispatcher.ts` (the `dispatchFacets` orchestrator), `facetRpcBus.ts` (never-reject RPC), and `facetReview.ts` (batched review UI).

## Custom tools

Define in `settings.json` under `sidecar.customTools`:

```json
{
  "sidecar.customTools": [
    {
      "name": "deploy_staging",
      "description": "Deploy the current branch to the staging environment",
      "command": "make deploy-staging BRANCH=$SIDECAR_INPUT"
    }
  ]
}
```

Schema (`CustomToolConfig` in [`src/config/settings.ts`](../src/config/settings.ts)):

```typescript
interface CustomToolConfig {
  name: string;        // tool name surfaced to the agent
  description: string; // description the LLM uses to decide when to call
  command: string;     // shell command; `$SIDECAR_INPUT` interpolates the LLM's arg
}
```

### Behavior

- Surfaces as a tool named `custom_<name>` in the catalog.
- The LLM's string argument becomes `$SIDECAR_INPUT` in the child process environment.
- `$SIDECAR_INPUT` passes through `redactSecrets()` before being set — a hallucinated API key in the LLM's arg can't leak via env var.
- Command output is captured as the tool result.
- Always requires per-call approval; no way to auto-allow.

### Trust gating

Custom tools are workspace-trust-gated via `checkWorkspaceConfigTrust`. A cloned repo's `.vscode/settings.json` can't inject `customTools` that run `curl | sh` until the user accepts the workspace-trust prompt in the VS Code palette.

## MCP servers

The Model Context Protocol spec and SDKs live at [modelcontextprotocol.io](https://modelcontextprotocol.io/). An MCP server exposes a set of tools via JSON-RPC; SideCar discovers them at connect time and namespaces each as `mcp_<server>_<tool>`.

Minimal config in `settings.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    },
    "local-tools": {
      "type": "stdio",
      "command": "/usr/local/bin/my-mcp-server",
      "args": ["--port", "3000"],
      "env": { "MY_API_KEY": "abc123" }
    }
  }
}
```

The three transports + their trust semantics + the reconnect lifecycle are documented in detail at [`docs/mcp-lifecycle-diagram.md`](mcp-lifecycle-diagram.md) (internal) and [`docs/mcp-servers.md`](mcp-servers.md) (user-facing).

### When to use MCP vs. a custom tool

- **Reusable across clients?** MCP. Claude Code, SideCar, and any other MCP client can all consume the same server.
- **Stateful or protocol-heavy?** MCP. The SDK handles JSON-RPC, streaming, session lifecycle.
- **One-off shell wrapper?** Custom tool. No need to stand up a server process.

### Injection defense

Every MCP tool response flows through [`wrapMcpOutput`](../src/agent/mcpManager.ts) and [`detectInjectionSignals`](../src/agent/mcpManager.ts) before reaching the agent. See [`SECURITY.md`](../SECURITY.md) for the threat model and defenses.

## Policy hooks

The agent loop's [`HookBus`](../src/agent/loop/policyHook.ts) is an extensibility point for authors who want to inject behavior *inside* the loop itself — gating turn completion, running post-tool validators, or pushing synthetic user messages to steer the agent.

Today this surface is available to first-party code (the four built-in hooks + `sidecar.regressionGuards` config) and to callers who construct `AgentOptions.extraPolicyHooks` directly. There is **no packaged-plugin API** yet — hooks ship either in the SideCar repo itself or in a fork.

### Interface

```typescript
// src/agent/loop/policyHook.ts
export interface PolicyHook {
  name: string;

  /**
   * Fires after every successful tool-execution turn. Return `true` if
   * the hook pushed a synthetic user message that should keep the loop
   * alive; `false` for passive observation.
   */
  runAfter?(state: LoopState, context: HookContext): Promise<boolean> | boolean;

  /**
   * Fires when the model produced no tool calls in a turn. Return `true`
   * to keep the loop alive (e.g., by pushing a "you're not done yet"
   * reprompt); `false` for natural termination.
   */
  runEmptyResponse?(state: LoopState, context: HookContext): Promise<boolean> | boolean;
}
```

The `state` parameter is the mutable `LoopState` — hooks can push messages into `state.messages`, inspect `state.iteration`, read gate state, etc. The `context` parameter carries the immutable per-call inputs (client, config, signal, callbacks, pending tool uses, tool results, full text).

### Built-in hooks (for reference)

The four built-ins registered by `defaultPolicyHooks()`:

| Hook | Phase | What it does |
| --- | --- | --- |
| `auto-fix` | afterToolResults | Detects common post-edit errors (lint, tsc, missing imports) and pushes a follow-up message asking the agent to fix them |
| `stub-validator` | afterToolResults | Rejects placeholder code (`TODO`, `// implement me`) in fresh writes |
| `critic` | afterToolResults | Adversarial LLM review of the turn's edits; pushes a blocking injection on high-severity findings |
| `completion-gate` | afterToolResults + emptyResponse | Tracks whether the agent ran lint / tests after claiming to be done; reprompts if not |

See [`src/agent/loop/builtInHooks.ts`](../src/agent/loop/builtInHooks.ts) for the adapters.

### Hook ordering

Registration order is execution order. The `HookBus` registers hooks in this order:

1. Built-ins (via `defaultPolicyHooks()`)
2. Regression guards loaded from `sidecar.regressionGuards` (gated behind `checkWorkspaceConfigTrust`)
3. `options.extraPolicyHooks` — runs last, sees every earlier mutation

Later hooks see what earlier hooks wrote to `state.messages`. Order matters when two hooks might want to inject into the same turn — whoever runs last wins on conflict.

### Writing a hook (first-party example)

[`src/agent/guards/regressionGuardHook.ts`](../src/agent/guards/regressionGuardHook.ts) wraps the `sidecar.regressionGuards` config as a `PolicyHook`. It reads the config, runs each guard command after relevant tool calls, and pushes a synthetic "regression detected" message when a guard fails. Pattern to copy:

```typescript
export const myHook: PolicyHook = {
  name: 'my-hook',
  async runAfter(state, context) {
    // Inspect the turn — what tools ran, what got edited, current state.
    const editedFiles = context.pendingToolUses
      .filter((t) => t.name === 'edit_file' || t.name === 'write_file')
      .map((t) => t.input.path as string);

    if (editedFiles.length === 0) return false;

    // Run your check. If it finds a problem, push a synthetic user
    // message that tells the agent what to do next.
    const problem = await checkMyInvariant(editedFiles);
    if (problem) {
      state.messages.push({
        role: 'user',
        content: `Regression detected: ${problem}. Please investigate before ending the turn.`,
      });
      return true; // loop continues
    }

    return false; // passive observation
  },
};
```

### Known gaps (future plugin surface)

No third-party packaged-plugin API exists today. A hypothetical plugin system would need:

- A discovery mechanism (e.g., `~/.sidecar/plugins/*.js` or VS Code extension contributions).
- A stable JS API surface (export shape, versioning).
- A trust-prompt UI (plugin code runs with extension privileges; at minimum the equivalent of workspace-trust + first-run consent).
- Isolation: plugins can see and mutate `LoopState`, which includes user prompts and tool arguments. Untrusted third-party code with that level of access is not something to enable casually.

Until that lands, custom hooks ship via fork or by contributing upstream. If you have a strong use case, [open an issue](https://github.com/nedonatelli/sidecar/issues) — real demand can move this up the roadmap.

## See also

- [Agent loop flow](agent-loop-diagram.md) — where hooks fire within one iteration.
- [Tool registry & dispatch](tool-system-diagram.md) — how custom tools + MCP tools compose with built-ins.
- [MCP lifecycle](mcp-lifecycle-diagram.md) — internal MCP manager + transport detail.
- [SECURITY.md](../SECURITY.md) — threat model; trust gates; secret-pattern catalog.
