# SideCar 2-Hour Dogfood Session

**Goal:** Use SideCar to develop SideCar. Every task below should be completed by asking SideCar to do it, not by editing manually. Keep a mental note of when it gets it right, when it needs a re-prompt, and when it fails entirely.

**Model:** `ministral-3:latest`  
**Mode:** Autonomous  
**Time box:** 2 hours

---

## Phase 1 — Baseline (30 min)

### 1.1 Run the full eval suite
```
npm run eval:llm
```
Ask SideCar: *"Run `npm run eval:llm` with a 600-second timeout and summarise which cases are still failing."*

> **Note:** The eval suite takes 3-5 minutes. Pass `timeout: 600` in the run_command call or SideCar will hit the 120s default shell timeout before the suite finishes.

Expected: it calls `run_command`, reads the output, and gives you a ranked list of failures.  
Watch for: does it parse the output correctly? Does it categorise the failures?

- [ ] Eval ran and produced output
- [ ] SideCar correctly identified failing cases
- [ ] SideCar suggested which are highest-priority to fix

---

### 1.2 Update CLAUDE.md with today's learnings
The `constants.ts` section of `CLAUDE.md` still references the old `LOCAL_CONTEXT_CAP` value. Several new constants were added today. Ask SideCar:

*"Read CLAUDE.md and src/config/constants.ts. The CLAUDE.md description of constants.ts is stale — update it to match what's actually in the file now."*

Expected: reads both files, diffs them, produces a targeted edit to the relevant paragraph.  
Watch for: does it read both files before editing? Does it make surgical edits or rewrite large sections?

- [ ] Reads both files before touching anything
- [ ] Makes minimal, accurate edits
- [ ] Does not introduce any new stubs or placeholders

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
