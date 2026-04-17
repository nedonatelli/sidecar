# Extending SideCar

Four extension surfaces — ordered by increasing power and increasing trust requirement:

1. **[Skills](#skills)** — markdown prompt fragments that inject into the system prompt when triggered. No code; no approval gate needed (content is just more text for the model). Best for: coding conventions, domain context, command templates.
2. **[Custom tools](#custom-tools)** — user-defined shell commands surfaced to the agent as callable tools. Simple to author, full shell privileges, always requires approval per call. Best for: internal CLIs, build / deploy wrappers, project-specific scripts.
3. **[MCP servers](#mcp-servers)** — external processes or HTTP endpoints that expose tools via the Model Context Protocol. SDK-based; own lifecycle. Best for: integrating with GitHub / Linear / Postgres / custom data sources, or any tool you want to share across Claude Code + SideCar + other MCP clients.
4. **[Policy hooks](#policy-hooks)** — TypeScript-level extension of the agent loop's `HookBus`. Full access to loop state; runs in-process. Best for: custom completion gates, domain-specific validators, regression guards.

| Surface | Authoring effort | Trust required | Sharable across clients |
| --- | --- | --- | --- |
| Skill | Minimal (markdown) | Workspace trust for project-local skills | ✅ (Claude Code compatible) |
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
