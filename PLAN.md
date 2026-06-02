# SideCar 2-Hour Dogfood Session

**Goal:** Use SideCar to develop SideCar. Every task below should be completed by asking SideCar to do it, not by editing manually. Keep a mental note of when it gets it right, when it needs a re-prompt, and when it fails entirely.

**Model:** `ministral-3:latest`  
**Mode:** Autonomous  
**Time box:** 2 hours

### What changed since the last session (regression targets)
- `basePrompt.ts` — grep-first tool guidance: model should now use `grep -n`, `jq`, `wc -l`, `head`/`tail`, `xargs`, `diff`, `node -e`, `python3 -c` instead of reading whole files or writing temp scripts
- `basePrompt.ts` — plan mode clarification: text-only response (no tool call) submits the plan; model should not attempt to call a tool to "exit" plan mode
- `stubValidator.ts` — new `placeholder-log` patterns: `console.log("[tool] ...")` stubs are now caught and reprompted
- `cycleDetection.ts` — frequency-over-window: hallucinated-path loops that interleave with other tool calls are now caught at 3 occurrences across the 8-slot window
- `fs.ts` — ENOENT suggestions: when `read_file` hits a missing path it now suggests similar files instead of returning a bare error

---

## Phase 1 — Baseline (30 min)

### 1.1 Run the full eval suite
```
npm run eval:llm
```
Ask SideCar: *"Run the eval suite and summarise which cases are still failing. Use this exact command: `SIDECAR_EVAL_CASE_TIMEOUT=600000 npm run eval:llm` and pass `timeout: 600000` on the run_command call itself — the suite takes 3-5 minutes and the default 120s shell timeout will cut it off."*

> **Note:** `SIDECAR_EVAL_CASE_TIMEOUT=600000` sets the per-case timeout (ms). `timeout: 600000` on the `run_command` tool call sets the shell session timeout. Both are required — without the second one, SideCar's own shell will kill the process at 120s regardless of the env var.

Expected: it calls `run_command`, reads the output, and gives you a ranked list of failures.  
Watch for: does it parse the output correctly? Does it categorise the failures?

- [ ] Eval ran and produced output
- [ ] SideCar correctly identified failing cases
- [ ] SideCar suggested which are highest-priority to fix

---

### 1.2 Validate CLI tool guidance
Test whether the new tool-preference rules actually change behaviour. Ask SideCar:

*"Three quick lookups: (1) What's the TypeScript compiler version in package.json? (2) How many test files are in src/? (3) What's the largest source file in src/ by line count?"*

Expected: uses `jq` for (1), `find` or `rg --files` + `wc -l` for (2), `find src/ -name "*.ts" | xargs wc -l | sort -rn | head -5` for (3). Should not call `read_file` for any of these.  
Watch for: does it reach for shell tools or fall back to reading files? Does it chain commands with `|`?

- [ ] Uses `jq` for the package.json lookup (not `read_file`)
- [ ] Uses `find`/`rg` + `wc` for counts (not `list_directory` + manual counting)
- [ ] Chains commands with pipes for the largest-file query

---

## Phase 2 — Real Improvements (60 min)

Pick **two** of the following tasks and work through them with SideCar. If SideCar completes one in under 10 minutes, pick a third.

### 2.A Fix `run-tests-fail-fix-iterate` eval case
This case was still failing: model runs `node src/stats.js`, sees the error, fixes the bug, but doesn't re-run.

Ask SideCar: *"Read tests/llm-eval/agentCases.ts and find the run-tests-fail-fix-iterate case. Read src/webview/handlers/basePrompt.ts. Rule 9 says 'after every run_command that shows an error, fix and re-run' — check if the rule is clear enough or if it needs a concrete example added. If it does, add one."*

- [ ] Reads both files without prompting
- [ ] Makes a targeted improvement to the example or rule wording
- [ ] Does not break existing tests

---

### 2.B Add `sidecar-md-enforces-convention` to the system prompt example
This case still fails: model writes a function but doesn't check SIDECAR.md for the @throws JSDoc rule. The system prompt tells it to read SIDECAR.md but doesn't show a concrete example of doing so.

Ask SideCar: *"Read src/webview/handlers/basePrompt.ts. The example turns section shows file-read and error-recovery patterns but nothing about reading SIDECAR.md and applying its rules. Add a third example turn showing: user asks to add a function → model reads SIDECAR.md first → sees the @throws rule → writes the function with correct JSDoc."*

- [ ] Reads the file before editing
- [ ] Adds the example in the right place (examples section, not rules)
- [ ] Passes `npm run test` after the change

---

### 2.C Improve the `testNotUpdated` gate message
The gate fires when tests ran but the test file wasn't updated, but the message is generic. It should tell the model what specifically to add.

Ask SideCar: *"Read src/agent/completionGate.ts. Find buildGateInjection and the testNotUpdated section. The message says 'if you added new functionality, add test cases' — make it more specific: tell the model to look at the existing test pattern in the file and add cases that match it."*

- [ ] Reads completionGate.ts before editing
- [ ] Makes the message more actionable without making it too long
- [ ] Updates the test in completionGate.test.ts to match

---

### 2.D Write the `ministral-3` eval baseline to a file
The eval currently prints results to stdout but doesn't save them. Ask SideCar:

*"Read tests/llm-eval/agentHarness.ts and tests/llm-eval/agentTypes.ts. Add an optional SIDECAR_EVAL_OUTPUT_FILE env var — when set, write the final AgentCaseResult[] array to that path as JSON after the suite completes. This lets us track pass-rate history over time."*

- [ ] Reads both files before writing anything
- [ ] Adds the feature without breaking existing behaviour
- [ ] Does not touch the core scoring logic

---

## Phase 3 — Friction Log (30 min)

By now you've done real work with SideCar. Fill this in:

### Things that worked well
- [ ] _SideCar did X without any re-prompting_
- [ ] _The diff looked exactly right the first time for: ___

### Things that needed a re-prompt
- [ ] _Had to re-prompt because: ___
- [ ] _The second prompt that worked was: ___

### Things that failed entirely
- [ ] _Could not complete even with multiple attempts: ___
- [ ] _What it did instead: ___

### Latency
- [ ] Fastest task: ___ seconds
- [ ] Slowest task: ___ seconds
- [ ] Acceptable? yes / no

### Would you use this for real work?
- [ ] Yes — it saved time overall
- [ ] Maybe — for simple tasks only
- [ ] Not yet — re-prompting overhead outweighs the benefit

---

## After the session

Commit the friction log findings and create GitHub issues for anything that failed twice. The failures become the next sprint.

```
git add PLAN.md
git commit -m "dogfood(session-1): friction log from 2-hour ministral-3 dev block"
```
