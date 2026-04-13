# SideCar LLM Evaluation Harness

This directory holds a small prompt-engineering regression suite. It
runs the SideCar base system prompt against a real LLM and scores the
responses against deterministic expectations so we can tell when a
prompt change, tool description edit, or compression tweak makes the
model behave worse.

It is **not** part of `npm test`. The main unit suite stays fast,
deterministic, and offline. Running real models is opt-in through
`npm run eval:llm`.

## Running

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run eval:llm
```

Cases that lack an available backend skip cleanly, so forgetting the
env var gives you a green run instead of a red one. A markdown
summary is printed after the last case.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Required to use the Anthropic backend (default). |
| `SIDECAR_EVAL_BACKEND` | Force a specific backend (`anthropic`). |
| `SIDECAR_EVAL_MODEL` | Override the model name (default: `claude-haiku-4-5-20251001` — the cheapest option). |

## Adding a case

1. Open `cases.ts` and append a new entry to `CASES`.
2. Write a **failing** version first — run the suite, confirm the
   scorer actually trips. Keyword lists have a way of being too loose
   in the "mustContain" direction and too strict in the "mustNotContain"
   direction. Prove the predicate catches what you intend.
3. Give the case at least one tag (`prompt`, `safety`, `honesty`,
   `tool-output`, etc.) so reports can be filtered later.
4. Keep `mustNotContain` tight — broad negations produce false positives
   on generations that happen to touch unrelated words.

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

The MVP invokes the model backend **directly** — it does not run the
full SideCar agent loop, the tool executor, or the MCP manager. The
reasoning:

- **Prompt engineering is the most frequent regression source.** We just
  rewrote `buildBaseSystemPrompt` (cycle-2 batch), added rules, and
  restructured the cached prefix. If any of that broke model behavior,
  a prompt-only eval catches it faster than a full-loop integration
  test.
- **Full-loop eval needs VS Code.** `runAgentLoop` takes dependencies
  that live on `ChatState` (MCP manager, workspace index, pending
  edits, skill loader, audit log). Spinning those up outside the
  extension host means either mocking them all (high surface area,
  easy to drift from reality) or running inside `@vscode/test-electron`
  (slow, complex). Neither pays off on day one.
- **A narrow harness is easier to extend.** Once the pattern is in
  place — case file, scorer, backend abstraction — adding tool-use
  evaluation later is a matter of replacing `backend.complete()`
  with `runAgentLoop()` and adding trajectory-based scorers. The
  shape stays the same.

## Intended workflow

- Run `npm run eval:llm` before landing any change to `buildBaseSystemPrompt`, tool descriptions, compression logic, or skills loading.
- Add a case every time we fix a prompt-level bug so the regression can't come back.
- Watch for cases that start passing AND failing on alternating runs — that signals a prompt that's borderline at the model's temperature, which is itself a regression to fix.

## Related

- Cycle-2 ai-engineering audit finding: *"No evaluation harness for LLM behavior. 1505 unit tests cover deterministic code; zero LLM-specific evaluation."*
- Base prompt source of truth: [`src/webview/handlers/chatHandlers.ts`](../../src/webview/handlers/chatHandlers.ts) → `buildBaseSystemPrompt`.
- Cases live in [`cases.ts`](cases.ts). Scorers in [`scorers.ts`](scorers.ts). Backend calls in [`backend.ts`](backend.ts). The vitest runner itself is [`prompt.eval.ts`](prompt.eval.ts).
