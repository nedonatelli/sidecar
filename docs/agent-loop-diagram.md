# Agent Loop Architecture

The agent loop is the core iteration engine that drives every SideCar agentic interaction. It lives in [`src/agent/loop.ts`](../src/agent/loop.ts) as a thin 255-line orchestrator that reads top-to-bottom as one iteration's pseudo-code. Every meaningful chunk of logic is delegated to a single-purpose helper under [`src/agent/loop/`](../src/agent/loop/).

## One iteration at a glance

```mermaid
flowchart TD
    Start([runAgentLoop]) --> Init[initLoopState<br/>bundle state, config, tools]
    Init --> Bus[HookBus setup<br/>defaultPolicyHooks +<br/>regressionGuardHooks +<br/>extraPolicyHooks]
    Bus --> Loop{iteration <<br/>maxIterations?}
    Loop -- no --> Finalize[finalize<br/>emit done, suggestions]
    Finalize --> Return([return messages])

    Loop -- yes --> Abort{signal.aborted?}
    Abort -- yes --> Finalize
    Abort -- no --> Compress[applyBudgetCompression<br/>pre-turn]
    Compress --> Exhausted{exhausted?}
    Exhausted -- yes --> BudgetBreak[emit budget warning] --> Finalize
    Exhausted -- no --> Notify[notifyIterationStart<br/>maybeEmitProgressSummary<br/>shouldStopAtCheckpoint]
    Notify --> Checkpoint{user stops<br/>at checkpoint?}
    Checkpoint -- yes --> Finalize
    Checkpoint -- no --> Stream[streamOneTurn<br/>SSE + tool_use parsing]

    Stream --> Terminated{terminated?}
    Terminated -- timeout --> TimeoutMsg[emit timeout] --> Finalize
    Terminated -- aborted --> Finalize
    Terminated -- no --> Resolve[resolveTurnContent<br/>strip repeats +<br/>parseTextToolCalls]

    Resolve --> HasTools{pendingToolUses<br/>length > 0?}

    HasTools -- no --> EmptyHook[hookBus.runEmptyResponse<br/>completion gate, etc.]
    EmptyHook --> Mutated{any hook<br/>mutated state?}
    Mutated -- yes --> Loop
    Mutated -- no --> Finalize

    HasTools -- yes --> Burst{exceedsBurstCap?}
    Burst -- yes --> Finalize
    Burst -- no --> Cycle{detectCycleAndBail?}
    Cycle -- yes --> Finalize
    Cycle -- no --> PushAsst[pushAssistantMessage]
    PushAsst --> Exec[executeToolUses<br/>spawn_agent / delegate_task /<br/>normal dispatch in parallel]
    Exec --> Account[accountToolTokens +<br/>pushToolResultsMessage]
    Account --> PostCompress[maybeCompressPostTool]
    PostCompress --> AfterHook[hookBus.runAfter<br/>auto-fix → stub → critic →<br/>completion-gate tracking]
    AfterHook --> PlanMode{approvalMode=plan<br/>&& iter=1?}
    PlanMode -- yes --> PlanEmit[emit plan for approval] --> Finalize
    PlanMode -- no --> Loop

    classDef hookStyle fill:#fef3c7,stroke:#d97706
    classDef toolStyle fill:#dbeafe,stroke:#2563eb
    classDef terminalStyle fill:#fee2e2,stroke:#dc2626
    class Bus,EmptyHook,AfterHook hookStyle
    class Stream,Exec toolStyle
    class BudgetBreak,TimeoutMsg,Finalize terminalStyle
```

## Submodule map

The orchestrator in [`loop.ts`](../src/agent/loop.ts) calls into focused helpers under [`src/agent/loop/`](../src/agent/loop/):

| Helper | Responsibility |
| --- | --- |
| [`state.ts`](../src/agent/loop/state.ts) | `initLoopState` bundles immutable inputs + mutable accumulators into one `LoopState` object |
| [`compression.ts`](../src/agent/loop/compression.ts) | `applyBudgetCompression` (pre-turn) + `maybeCompressPostTool` (after tool results) |
| [`streamTurn.ts`](../src/agent/loop/streamTurn.ts) | `streamOneTurn` owns the streamChat request loop with per-event timeout + abort handling; captures partial text for `/resume` on mid-stream failure |
| [`textParsing.ts`](../src/agent/loop/textParsing.ts) | `resolveTurnContent` → `parseTextToolCalls` + `stripRepeatedContent` for models that emit tool calls as text (qwen3, Hermes) instead of structured tool_use |
| [`cycleDetection.ts`](../src/agent/loop/cycleDetection.ts) | `exceedsBurstCap` (max tools per iteration) + `detectCycleAndBail` (ring buffer of recent tool+args tuples) |
| [`messageBuild.ts`](../src/agent/loop/messageBuild.ts) | `pushAssistantMessage` + `pushToolResultsMessage` + `accountToolTokens` — single source of truth for message-array mutation |
| [`executeToolUses.ts`](../src/agent/loop/executeToolUses.ts) | Parallel tool dispatch; special-cases `spawn_agent` + `delegate_task`; threads `cwdOverride` into every `ToolExecutorContext` |
| [`policyHook.ts`](../src/agent/loop/policyHook.ts) | `HookBus` + `PolicyHook` interface. Hooks fire via `runAfter` (post-tool) and `runEmptyResponse` (no tool calls this turn) |
| [`builtInHooks.ts`](../src/agent/loop/builtInHooks.ts) | `defaultPolicyHooks()` wraps the four built-ins as `PolicyHook` adapters |
| [`criticHook.ts`](../src/agent/loop/criticHook.ts) | Adversarial critic — spawns a second LLM call to review the agent's edits; can push a synthetic user message demanding more work |
| [`gate.ts`](../src/agent/loop/gate.ts) | Completion gate — refuses to let the agent end the turn without running lint/tests when it claims to be done |
| [`stubCheck.ts`](../src/agent/loop/stubCheck.ts) | Post-tool validator that rejects placeholder code (`TODO`, `// implement me`, …) |
| [`notifications.ts`](../src/agent/loop/notifications.ts) | `notifyIterationStart` + `maybeEmitProgressSummary` + `shouldStopAtCheckpoint` (user interrupt every N iterations) |
| [`finalize.ts`](../src/agent/loop/finalize.ts) | Post-loop teardown + next-step suggestion synthesis |

## Hook bus ordering

The `HookBus` runs hooks in registration order:

1. **Built-ins** (auto-fix → stub validator → critic → completion-gate tracking) — registered first via `defaultPolicyHooks()`.
2. **Regression guards** — loaded from `sidecar.regressionGuards` config, gated behind `checkWorkspaceConfigTrust`.
3. **User extras** — `options.extraPolicyHooks` registered last. These see every mutation earlier hooks made to `state.messages`.

Two hook phases:

- **`afterToolResults`** (`hookBus.runAfter`) — fires after every successful tool-execution turn. Hooks may push synthetic user messages that demand more work.
- **`emptyResponse`** (`hookBus.runEmptyResponse`) — fires when the model produced no tool calls. Any hook that mutates state keeps the loop alive; if none mutate, the loop naturally terminates.

## Termination paths

The loop can exit via any of:

- **Natural end**: model produced no tool calls and no hook wanted to reprompt.
- **Plan mode**: first iteration completed, `onPlanGenerated` fired for user approval.
- **Iteration cap**: `state.iteration >= state.maxIterations`.
- **Abort**: `signal.aborted` between iterations or mid-stream.
- **Budget exhaustion**: `applyBudgetCompression` couldn't fit under `maxTokens`.
- **Burst cap**: too many tools attempted in one iteration.
- **Cycle detected**: same tool+args tuple seen too many times in the recent ring.
- **Timeout**: a single stream turn exceeded `sidecar.requestTimeout`.
- **Checkpoint refused**: `onCheckpoint` returned `false`.

All paths route through `finalize(state, callbacks)` which emits the final `onDone` callback and synthesizes next-step suggestions.

## Per-run isolation

`options.toolRuntime` is a per-run `ToolRuntime` carrying the persistent shell session + symbol-graph reference. [`BackgroundAgentManager`](../src/agent/backgroundAgent.ts) creates a fresh `ToolRuntime` per run and disposes it in `finally` so parallel background agents don't share a shell — two agents both doing `cd` or `export` would otherwise trample each other. `options.cwdOverride` pins every tool call's working directory, used by Shadow Workspaces to route fs writes into an ephemeral git worktree.
