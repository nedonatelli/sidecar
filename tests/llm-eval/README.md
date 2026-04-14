# SideCar LLM Evaluation Harness

Two-layer regression suite for LLM-driven behavior:

1. **Prompt layer** — exercises `buildBaseSystemPrompt` against a real
   model with no tools. Catches regressions in the base system
   prompt, tool descriptions, compression logic, skills loading, and
   any other prompt-engineering change that would alter model
   behavior before tools even come into play. Lives in
   [`prompt.eval.ts`](prompt.eval.ts) + [`cases.ts`](cases.ts).

2. **Agent-loop layer** — runs `runAgentLoop` end-to-end against a
   real model with a sandboxed temp-dir workspace. Catches
   regressions in tool selection (does the agent reach for `grep`
   instead of reading five files), argument shape (is the path
   reasonable), and post-run workspace state (did the edit actually
   land). Lives in [`agent.eval.ts`](agent.eval.ts) +
   [`agentCases.ts`](agentCases.ts).

Both layers are **not** part of `npm test`. The main unit suite stays
fast, deterministic, and offline. Running real models is opt-in
through `npm run eval:llm`, which runs both layers in one pass.

## Running

```bash
# Default: both layers against local Ollama (free, no key needed)
npm run eval:llm

# Force a specific backend for one or both layers
SIDECAR_EVAL_BACKEND=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:llm
SIDECAR_EVAL_BACKEND=openai OPENAI_API_KEY=sk-... npm run eval:llm

# Pin a specific model
SIDECAR_EVAL_BACKEND=anthropic SIDECAR_EVAL_MODEL=claude-sonnet-4-6 npm run eval:llm
```

**Agent-loop cases default to local Ollama** because they burn real
tokens — a single agent-loop case can easily spend 10k+ input tokens
as the model reads files and calls tools. Paid backends are
opt-in via `SIDECAR_EVAL_BACKEND=anthropic|openai`.

**The prompt layer defaults to Anthropic** (with
`ANTHROPIC_API_KEY`) because it's a single completion per case and
the cheapest Haiku model keeps the run under a nickel. It skips
cleanly when no key is configured.

Cases that lack an available backend skip cleanly, so forgetting an
env var gives you a green run instead of a red one. A markdown
summary is printed after the last case in each layer.

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SIDECAR_EVAL_BACKEND` | Force a specific backend: `ollama`, `anthropic`, or `openai`. | Agent layer: `ollama`. Prompt layer: first available (`anthropic` if key set). |
| `SIDECAR_EVAL_MODEL` | Override the model name. | Layer- and backend-specific. See `agentHarness.ts` and `backend.ts`. |
| `SIDECAR_EVAL_BASE_URL` | Override the backend base URL. Useful for OpenAI-compatible proxies or non-standard Ollama ports. | Provider default. |
| `ANTHROPIC_API_KEY` | Required for the Anthropic backend. | — |
| `OPENAI_API_KEY` | Required for the OpenAI backend. | — |

## Adding a case

### Prompt layer

1. Open [`cases.ts`](cases.ts) and append a new entry to `CASES`.
2. Write a **failing** version first — run the suite, confirm the
   scorer actually trips. Keyword lists have a way of being too loose
   in the "mustContain" direction and too strict in the "mustNotContain"
   direction. Prove the predicate catches what you intend.
3. Give the case at least one tag (`prompt`, `safety`, `honesty`,
   `tool-output`, etc.) so reports can be filtered later.
4. Keep `mustNotContain` tight — broad negations produce false positives
   on generations that happen to touch unrelated words.

### Agent-loop layer

1. Open [`agentCases.ts`](agentCases.ts) and append a new entry to `AGENT_CASES`.
2. Declare the minimal workspace fixture needed — a single file or a
   handful of small files. Big fixtures waste the agent's turns on
   reading instead of doing what you're testing.
3. Write a **failing** version first: pick a behavior you want to
   pin, assert on it, then run the suite with the system prompt
   temporarily hobbled to prove your predicate trips.
4. Prefer trajectory assertions (`toolsCalled`, `toolCallMatches`)
   over file-state assertions when possible — tool selection is
   the most common thing to regress when we tweak tool descriptions
   or prompts, and trajectory assertions are faster to debug than
   post-run content assertions.
5. Use `toolsNotCalled` to forbid specific wrong answers. "Agent
   didn't touch package.json" is a valid and useful predicate.
6. Match tool-call inputs with **substring matching** via
   `toolCallMatches` — the scorer does `actual.includes(expected)`
   for string fields, which tolerates `src/a.ts` vs `./src/a.ts`
   vs `a.ts`. Exact matches are too brittle for LLM output.

### Scoring model

All scoring is deterministic so results are stable across runs:

- `mustContain` — case-insensitive substring, all listed must be present.
- `mustNotContain` — case-insensitive substring, none may be present.
- `mustMatch` / `mustNotMatch` — regex, same meaning.
- `minLength` / `maxLength` — character-count bounds on the response.

LLM-as-judge scoring is not implemented yet; when added it will live in
`scorers.ts` as an opt-in predicate. The MVP sticks to deterministic
checks to keep the regression signal crisp.

## How this harness is shaped (and why it's small)

The **prompt layer** invokes the model backend directly — no
SideCarClient, no agent loop, no tool executor, no MCP manager. The
reasoning:

- **Prompt engineering is the most frequent regression source.** We
  rewrote `buildBaseSystemPrompt` in cycle-2, added rules, and
  restructured the cached prefix. A prompt-only eval catches any of
  that breaking model behavior faster than a full-loop test.
- **It stays cheap and fast.** Single completion, single deterministic
  scorer, no filesystem, no tool spawn. Whole suite runs in seconds.

The **agent-loop layer** runs the full `runAgentLoop` against a
sandboxed temp-dir workspace:

- **It turned out `runAgentLoop` doesn't need `ChatState`.** Despite
  earlier assumptions in this README, the agent core takes a
  `SideCarClient`, a message array, callbacks, an abort signal, and
  options — that's it. `ChatState` is purely UI plumbing
  (`PendingEditStore`, webview messages, skill loader, etc.) and
  isn't needed to execute tools or score trajectories.
- **The workspace sandbox mutates the vitest vscode mock** to point
  at a per-case temp dir and swap `workspace.fs.*` for real
  `node:fs`-backed wrappers. Each case gets an isolated scratch
  workspace and the mutation is reverted in `finally` so cases can't
  interfere. See [`workspaceSandbox.ts`](workspaceSandbox.ts).
- **Agent cases burn real tokens.** The default backend is local
  Ollama so the suite is free to run in a development loop. Paid
  backends are opt-in.

Both layers share the same vitest config
([`vitest.eval.config.ts`](../../vitest.eval.config.ts)) and the same
`npm run eval:llm` entry point.

## Intended workflow

- Run `npm run eval:llm` before landing any change to `buildBaseSystemPrompt`, tool descriptions, compression logic, or skills loading.
- Add a case every time we fix a prompt-level bug so the regression can't come back.
- Watch for cases that start passing AND failing on alternating runs — that signals a prompt that's borderline at the model's temperature, which is itself a regression to fix.

## Related

- Cycle-2 ai-engineering audit finding: *"No evaluation harness for LLM behavior. 1505 unit tests cover deterministic code; zero LLM-specific evaluation."*
- Base prompt source of truth: [`src/webview/handlers/chatHandlers.ts`](../../src/webview/handlers/chatHandlers.ts) → `buildBaseSystemPrompt`.
- Cases live in [`cases.ts`](cases.ts). Scorers in [`scorers.ts`](scorers.ts). Backend calls in [`backend.ts`](backend.ts). The vitest runner itself is [`prompt.eval.ts`](prompt.eval.ts).
