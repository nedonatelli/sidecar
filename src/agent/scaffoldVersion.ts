/**
 * Scaffold versioning — make every benchmark result attributable to the exact
 * scaffold that produced it.
 *
 * The scaffold (verification stack + gates + guards + repair) evolves fast, and
 * a resolve/lift number is only meaningful if you know WHICH scaffold generated
 * it. `run.manifest.json` already pins model/seed/temp/dataset; this adds the
 * scaffold version + a snapshot of which mechanisms were actually ON, so
 * "scaffold-on = 14%" is comparable across time only when the versions match.
 *
 * ## Versioning scheme (semver for the scaffold)
 *
 * The version captures the IMPLEMENTATION behind the flags; `describeScaffold`
 * captures which flags were on. Two runs are comparable iff BOTH match. Bump per:
 *
 * - **MAJOR** (X.0.0) — a mechanism is ADDED, REMOVED, or its verification
 *   SEMANTICS change (new gate, changed gate/repair logic, changed do-no-harm
 *   behavior). Cross-MAJOR results are NOT directly comparable.
 * - **MINOR** (x.Y.0) — a new mechanism ships behind a flag (available, default
 *   OFF), or a default arm composition changes. Comparable when the active
 *   feature snapshots match.
 * - **PATCH** (x.y.Z) — tuning WITHIN a mechanism (a threshold, a reprompt
 *   string) that doesn't change which mechanisms run.
 *
 * Discipline: the PR that changes a scaffold mechanism bumps the version AND
 * appends to the changelog below (what counts: AGENTS.md "Scaffold version").
 * The human-facing registry is `docs/scaffold-versions.md`.
 *
 * ## Changelog
 * - **3.1.0** (2026-07) — adaptive scaffolding ON by default, and capability
 *   tiers learned from measured performance rather than parsed from the model's
 *   filename. MINOR: the default arm composition changed, so runs either side of
 *   this boundary are comparable only when their per-arm feature snapshots match.
 *   The `medium` tier is provably identical to the historical constants (it is now
 *   BUILT from them — see scaffoldingProfileNeutrality.test.ts), so the flip is a
 *   no-op for a medium model. `weak` measured flat across llama3.2 / ministral-3 /
 *   granite4.1 (dogfood, 2 trials, both arms — not one case moved). `strong` had
 *   its verification budgets RESTORED to parity with medium (maxActionReprompts
 *   and maxGateInjections were 1, now 2): against claude-sonnet-5 the action
 *   reprompt fired in 10/10 runs — a frontier model narrates instead of acting at
 *   least once per task — so a budget of 1 runs permanently at its ceiling; and the
 *   completion gate injected 0 times, so the cut was never exercised at all. Strong
 *   keeps only the latency relaxations (burst cap, compression threshold).
 * - **3.0.0** (2026-07) — always-on dispatch guards + edit recovery + text repair.
 *   Adds the example-replay guard (executor bounces tool calls whose arguments
 *   verbatim-match the example in that tool's own description — no flag,
 *   always on, restricted to examples with ≥2 arguments so legitimate
 *   single-key calls can't collide by coincidence) and escalating
 *   dispatch-bounce messages (2nd consecutive
 *   identical bounce: "do not resubmit"; 3rd+: "stop retrying, change
 *   approach"; streaks reset on any successful call). textParsing's bare-JSON
 *   path now recognizes the OpenAI function-call shape
 *   ({"type":"function","function":{name,parameters}}), salvages
 *   truncated emissions missing their closing brace, and counts braces
 *   string-aware (a `{` inside a JSON string value used to run the depth off,
 *   delivering a well-formed rename as `edit_file({})`). edit_file gains an
 *   edit-time tree-sitter syntax guard, a Python indentation check, and
 *   two-tier intent recovery: a guessed region is APPLIED only when it beats
 *   the runner-up by ≥3 distinctive words (zero wrong in 177 commitments over
 *   1,700 real edits) and otherwise merely SUGGESTED, writing nothing. The
 *   action reprompt now fires after tool calls at all — it had been reading a
 *   tool result as "the user said nothing", so a model that narrated an edit
 *   instead of making it terminated as done. MAJOR:
 *   the shared dispatch/repair path changed; a model's measured resolve rate
 *   is not comparable across this boundary (llama3.2-class models gain
 *   previously-lost tool calls).
 * - **2.0.1** (2026-07) — keep-best ratchet's over-engineering threshold
 *   (`DEFAULT_OVER_ENGINEER_BYTES`) tightened from 4096 to 0. A local SWE-bench
 *   repro of scaffold-on bail-early found a concrete case (a 536-byte wrong edit
 *   to an unrelated file, driven by a cycle-detection bail) that slid under the
 *   old 4 KB threshold untouched. A byte-size gate alone can't distinguish a
 *   legitimate small addition from a wrong one, so the default now reverts ANY
 *   scaffold-tail growth that didn't earn a proven test-signal improvement.
 *   PATCH-level: tunes a threshold within the existing ratchet, doesn't add,
 *   remove, or change which mechanisms run.
 * - **2.1.0** (2026-07) — keep-best ratchet DEFAULT-ON. `scaffolding.keepBest`
 *   flips to true: the default harness now snapshots at the scaffold boundary
 *   and reverts unproven scaffold-tail changes at termination. MINOR: changes
 *   which mechanisms run by default (evidence: 150-run 3-arm SWE campaign —
 *   over-engineering 36.6→29.6KB mean patch, 6/50 reverts, do-no-harm clean;
 *   resolve non-regression vacuous at 7B/Verified, re-verify on a resolvable
 *   class — see Prove-or-Prune Ledger).
 * - **7.0.24** (2026-11) — a timed-out `run_tests` is an error, not a result;
 *   shell fixes (Part of #422). The model gets "did not finish, so this
 *   output is partial" with `is_error`, and the completion gate doesn't count
 *   the run; `exit code: -1` classifies as a fail. Also: terminal commands run
 *   one at a time, an unknown terminal exit code is -1, the Git Bash stdin
 *   guard applies on Windows, and the unittest fallback uses `python3` when
 *   that's what was found. PATCH. e4b SWE canary (150 pairs): resolve 13% in
 *   both arms, no discordant pairs; no `run_tests` timed out, so the error
 *   path wasn't exercised there.
 * - **7.0.23** (2026-11) — a commit SideCar couldn't check is held for
 *   approval. The commit review returned "no concerns" when a git call inside
 *   the repository failed or timed out, so the commit went ahead unchecked; it
 *   now holds the commit, keeping whatever it found before the failure. PATCH.
 *   SWE runs make no commits, so eval runs are unaffected.
 * - **7.0.22** (2026-11) — scratch cleanup moves only scratch this run made,
 *   by narrower name rules (#418). A file is moved only if this run's file
 *   tools wrote it or one of its commands names it, never from a test
 *   directory, and bare root scripts (`conftest.py`, `setup.py`) are kept.
 *   PATCH. gemma4:31b SWE canary on the #387 tasks: patches carrying scratch
 *   0/24 → 3/24 (the three test-directory files now kept), resolve 10 vs 11
 *   (1 discordant pair, traced to volatile tool output).
 * - **7.0.21** (2026-11) — a link whose target doesn't exist is judged by
 *   that target. The workspace path check couldn't follow such a link, so it
 *   judged it as a new file at the link's own path. PATCH. Eval tasks contain
 *   no such links.
 * - **7.0.20** (2026-11) — Ollama's `think: false` is sent where Ollama reads
 *   it; the per-model thinking list is removed (#469). Chat requests put
 *   `think` inside `options`, which Ollama doesn't read, so neither
 *   `ollama.disableThinking` nor the problematic-thinking model list ever
 *   turned thinking off. `think` is now a top-level field, sent only when the
 *   user turns thinking off (setting or chat header switch), and the list is
 *   gone. PATCH. The default eval models (gemma4:e4b, gemma4:31b, ministral-3)
 *   send the same requests; the eval backend's one-shot `complete()` (prompt
 *   eval, retrieval judge) now really runs thinking-off.
 * - **7.0.19** (2026-11) — image prompts run with their text; autonomy
 *   answers only approvals (#419). A prompt with images ran with empty text,
 *   so retrieval, skill matching and message framing saw nothing; it now runs
 *   with its text, and keeps its images on regenerate and Reconnect.
 *   Switching to autonomous answers "Allow" only on cards that offer it:
 *   clarifying questions, checkpoints, diff previews and irrecoverable
 *   reconfirms stay pending instead of getting "Allow". PATCH. No eval: the
 *   evals send no images and never switch modes mid-run.
 * - **7.0.18** (2026-11) — graph-expanded retrieval hits use 1-based lines
 *   (#426). Caller and callee bodies in system-prompt retrieval and
 *   `project_knowledge_search` started a line early and lost their last line,
 *   and a call on a function's last line was never attributed. The
 *   summarizer's timeout and Stop cancel its request. The fallback workspace
 *   context (index not ready) is passed verbatim; a filter that never filtered
 *   and joined lines before `### ` headings is removed. PATCH. No eval: neither
 *   eval harness attaches a symbol graph or calls injectSystemContext.
 * - **7.0.17** (2026-11) — integration tool results (#427). `mutation_test`
 *   in a shadow or fork runs its tests there, not on the main tree, so mutants
 *   can be killed. GitHub check runs and review comments are read past the
 *   first page. The dependency check asks OSV about the version an npm
 *   lockfile installed. Custom tools start on Windows. PATCH. No eval: the SWE
 *   and agent evals use none of these tools.
 * - **7.0.16** (2026-11) — auto-fix reads which files a call changed. The
 *   auto-fix pass took its files from `write_file`/`edit_file` calls by name
 *   and input path; it now reads each call's outcome (ADR-008), so a refused or
 *   no-op edit no longer spends a retry, an aliased `str_replace` is checked,
 *   and a deleted file is skipped. PATCH. No eval: auto-fix is off by default,
 *   and only the ablation arms turn it on; ablation runs at 7.0.15 and 7.0.16
 *   are not comparable on the autoFix arm.
 * - **7.0.15** (2026-11) — inferred edits keep CRLF and bracket balance (#163).
 *   An inferred region in a CRLF file no longer ends in the last line's `\r`,
 *   which left a bare LF (ML-34). The not-found inference path applies the
 *   delimiter-balance check the missing-search path already did, the only
 *   structural guard for a file with no grammar (ML-46). Region scoring is one
 *   sliding pass instead of a rescan per window, with identical results: 46.7 s
 *   → 9 ms on a 730-line replace (ML-33). PATCH. No eval: inferred writes to
 *   CRLF and no-grammar files are rare, and ML-33 changes only running time.
 * - **7.0.14** (2026-11) — edit_file failures are described more accurately
 *   (#161). The stub check reads only calls that changed a file, and skips a
 *   placeholder restated from that edit's `search` (ML-08). A multi-line
 *   `within` written with LF resolves in a CRLF file (ML-31). A search found
 *   only above its `within` is reported as such, not as "not found" (ML-74).
 *   PATCH. e4b SWE canary, 150 pairs against 7.0.2: resolve 20 = 20 with no
 *   discordant pair, stub reprompts 5 → 0; three P2P differences trace to
 *   volatile tool output. The fourth, from a stale-read change since taken
 *   out, re-ran identical to the base.
 * - **7.0.13** (2026-11) — DuckDB and Postgres schema tools read real rows.
 *   On DuckDB, `db_query` rows, `db_list_tables` and `db_describe_table` read
 *   the driver's rows as objects, but it returns arrays: names and values did
 *   not line up, and tables and columns came back undefined. Row counts now
 *   use the table's schema on both engines. PATCH. No eval: the database tools
 *   are offered only when database profiles are configured, and no eval
 *   configures one.
 * - **7.0.12** (2026-11) — switch_backend no longer offers Kickstand.
 *   `switch_backend`'s description, `profile` enum and enum description drop
 *   the unreleased Kickstand profile. PATCH. No eval: the evals send
 *   `switch_backend` as a one-sentence stub, which is unchanged.
 * - **7.0.11** (2026-11) — Anthropic cache tokens count toward the context
 *   estimate. Compression anchors on the last turn's input tokens. Anthropic's
 *   `inputTokens` leaves out the cached prefix, so with prompt caching a long
 *   chat never compressed. The anchor now adds `cacheCreationInputTokens` and
 *   `cacheReadInputTokens`, which other backends report as 0. A pinned
 *   `sidecar.ollama.numCtx` / `SIDECAR_OLLAMA_NUM_CTX` also sets the context
 *   budget. PATCH. No eval: the eval harness runs on Ollama, which reports no
 *   cache tokens, and no eval script pins `SIDECAR_OLLAMA_NUM_CTX`.
 * - **7.0.10** (2026-11) — db_execute reports the rows a write changed.
 *   `db_execute` reported "Rows affected" from the rows returned, and asked for
 *   none, so every write read as 0 and a model could send an INSERT again. The
 *   count now comes from the driver, or reads `unknown`, and `RETURNING` rows
 *   render. In Audit Mode the result says the statement did not run, and the
 *   tool description says it is not executed there. PATCH. No eval: the
 *   database tools are offered only when database profiles are configured, and
 *   no eval configures one.
 * - **7.0.9** (2026-11) — review mode queues delete_file. In review mode
 *   `delete_file` is queued for review like a write, with no prompt, and until
 *   it is accepted reads and searches treat the file as gone. PATCH. No eval:
 *   review mode is not used in the evals.
 * - **7.0.8** (2026-11) — mutation_test and db_migrate_up follow the command
 *   rules. `mutation_test`'s `test_command` and `db_migrate_up`'s custom
 *   command get the checks `run_command` gets (deny and ask rules,
 *   destructive-command and install confirmation), and the file `mutation_test`
 *   mutates gets `write_file`'s path checks. PATCH: existing guards applied to
 *   two more tools. No eval: neither tool is used in the SWE or agent evals.
 * - **7.0.7** (2026-11) — untrusted-content markers stay intact. Marker text
 *   inside untrusted content is made inert, so a marked block runs to its end
 *   and already-marked-looking text is still checked. PATCH: tuning within the
 *   injection guard. No eval: the eval repos contain no marker text.
 * - **7.0.6** (2026-11) — git_diff leaves credential files out. `git_diff`
 *   names a changed credential file without showing its lines, as `grep` and
 *   `read_file` already do. PATCH: model-facing tool-result text. No eval:
 *   SWE-bench repos have no such files.
 * - **7.0.5** (2026-11) — install approval reads each package manager's flags.
 *   The install approval parses flags per package manager, so a short flag that
 *   takes a value for one tool no longer hides the package after it, and
 *   versioned `pip3.11 install` is recognized. PATCH: tuning within the install
 *   guard. No eval: it changes only which installs are asked about, and the
 *   evals auto-approve.
 * - **7.0.4** (2026-11) — type-to-confirm covers more destructive commands. The
 *   destructive-command confirmation recognizes Windows and PowerShell
 *   recursive deletes, `find -delete` under a path, whole-tree `git
 *   checkout`/`git restore`, and more `rm -rf` and force-push spellings,
 *   including inside `bash -c`. A plain `rm -f file` no longer asks as if
 *   recursive. PATCH: tuning within the guard. No eval: the evals auto-approve,
 *   so the confirmation never shows there.
 * - **7.0.3** (2026-11) — every tool call gets its own id within a chat (#417).
 *   Native Ollama and the text-form parsers numbered calls from 0 on every
 *   request, so `state.toolOutcomes` (ADR-008) handed a call that recorded no
 *   outcome the entry an earlier call left under the same id: about 94% of
 *   calls reused an id, and a read after an edit counted as a file change. A
 *   repeated id is now renamed `<id>-N`. PATCH: the outcome consumers are
 *   unchanged and now read the right entries; reprompt and ratchet counts from
 *   7.0.0-7.0.2 runs include the phantom changes.
 * - **7.0.2** (2026-11) — edit_file refuses fewer edits that were fine (#162
 *   ML-42/43/44/70). The dropped-definition guard reads a changed definition
 *   line as still there and allows deleting a whole block or a lone decorator;
 *   the shadow-definition guard checks code files only, skips Python
 *   triple-quoted strings, and allows a reassignment built on the prior value.
 *   PATCH: tuning within edit_file's guards.
 * - **7.0.1** (2026-11) — escalate only a repeated call; decline a wrong
 *   inferred write (#161 ML-72, #163 ML-20/ML-71). The tool-error streak behind
 *   "N consecutive ... rejected for the same reason" keys on a hash of the
 *   call's arguments, so only a resubmitted identical call escalates. The
 *   not-found APPLY tier declines a region that stops short, sits at another
 *   indentation, or lacks the literal `\n` escapes of a one-line replace; an
 *   applied inferred edit records tier `inferred` and the syntax verdict.
 *   PATCH: tuning within edit_file and the tool-error suffix.
 * - **7.0.0** (2026-11) — structured tool outcomes (#367, ADR-008). write_file,
 *   edit_file and delete_file report what each call did (mutated, noop,
 *   failed, plus staged), and the action reprompt, completion gate, regression
 *   guard, circularRewrite, stale-read mark and no-file-write gate read that
 *   report instead of the result text. An inferred edit counts as a change
 *   everywhere; a failed or no-op edit no longer triggers a post-write
 *   regression guard; a review-mode queued edit counts as a change; aliased
 *   calls are treated as the tool they run as. MAJOR: changed gate and guard
 *   trigger logic.
 * - **6.0.3** (2026-11) — a missing checker is a final answer (#279).
 *   run_command appends a note when a checker (tsc, eslint, jest, ts-node,
 *   ...) can't run because it isn't installed: don't create a project, install
 *   a toolchain or write config to make it run; use get_diagnostics and say the
 *   change is unverified beyond it. run_tests recommends `npx tsc --noEmit`
 *   only where TypeScript is installed, and its no-runner answers now forbid
 *   building a runner rather than writing a test file. PATCH: tool-result
 *   wording within existing tools.
 * - **6.0.2** (2026-11) — web-tree-sitter 0.24.7 → 0.25.10 (#400). Every
 *   grammar the agent's tools parse with (the edit-time syntax check, the
 *   symbol graph, find_references) now runs on the newer runtime, and Dart
 *   symbols come from its grammar instead of the regex fallback. Dart is still
 *   not syntax-checked; bash is still disabled. PATCH: same mechanisms, new
 *   parser runtime under them.
 * - **6.0.1** (2026-11) — run_command rewrites a cmd-style `nul` redirect
 *   (`>nul`, `2>nul`, `&>nul`, `<nul`, any case) to `/dev/null` when the shell
 *   is Git Bash on Windows, where it otherwise creates an undeletable `nul`
 *   file (#395). Quoted text is left alone. PATCH: input handling of an
 *   existing tool.
 * - **6.0.0** (2026-11) — scratch cleanup, `scaffolding.scratchCleanup`,
 *   default ON. At the end of a run that wasn't stopped, files the run
 *   created (untracked now, not at the start) that have a scratch name or are
 *   scripts in the root, and that nothing else in the change refers to, move to
 *   `.sidecar/scratchpad/<run id>/`, which ignores itself. MAJOR: a mechanism
 *   is added to the default scaffold (measured: gemma4:31b patches carrying
 *   scratch 15/24 → 2/24, resolve 11 = 11).
 * - **5.1.21** (2026-10) — run_tests reads a test target sent under another
 *   name. `path`, `test_file`, `test_path`, `module`, `test_module`, `label`
 *   and `test_label` are read as `file` (with a note saying so); any other
 *   unknown key is named as ignored; a call with no `command`, no `file` and
 *   only unknown keys throws instead of running the whole suite. The completion
 *   gate records the call against the same target. PATCH: input handling of an
 *   existing tool.
 * - **5.1.20** (2026-10) — a run_command that only searches spends grep's
 *   budget. A command whose every segment is a search (grep, rg, find, ls,
 *   cat, head, tail, wc, sed -n, ...) or a cd, with no write, counts as a
 *   grep call; its refusal says why. PATCH: re-keys calls to an existing
 *   budget; no budget size changes.
 * - **5.1.19** (2026-10) — a repeated budget refusal escalates, and a run of
 *   refused repeats stops. From the second refusal of a tool on, the message
 *   says further calls will be refused too and names offered tools with budget
 *   left; a turn whose every call hits a spent budget, after one tool was
 *   refused 3 times, gets the #222 nudge once, then stops the run. PATCH: the
 *   text of an existing refusal and a pass inside existing cycle detection.
 * - **5.1.18** (2026-10) — an inferred edit marks its file as written since
 *   the last read. The stale-read guard only knew "File edited:/written:", so
 *   after "Applied inferred edit to …" it still trusted the earlier read.
 *   PATCH: what an existing guard recognizes.
 * - **5.1.17** (2026-10) — a "No change needed" edit is not a file mutation.
 *   It counted, so a run that had changed nothing switched off the action
 *   reprompt's "already done?" escape and the read-only cycle nudge. PATCH:
 *   what an existing counter counts.
 * - **5.1.16** (2026-10) — a command that did not run is a tool error. Exit
 *   127/126/9009 and a failed shell were returned as ordinary results, so the
 *   model read them as success; they now carry isError, the shell's message
 *   and a note naming the program. PATCH: error flag and text of an existing
 *   result.
 * - **5.1.15** (2026-10) — the eol match note names the search's own line
 *   ending. It read the replacement after conversion to the file's ending, so
 *   an LF search on a CRLF file was told it "used CRLF" (3,794 of 3,909 notes).
 *   The trailing-space note also says when line endings differed. PATCH: text
 *   of an existing note.
 * - **5.1.14** (2026-10) — the commit check also asks about files .gitignore
 *   matches: force-added ones, ones tracked from before the rule, and a
 *   command that runs `git add -f`. PATCH: two more conditions on the 5.1.9
 *   approval. (5.1.11 was held for this PR, which merged after 5.1.13.)
 * - **5.1.13** (2026-10) — a completion-gate nudge no longer counts as the
 *   user speaking. The action reprompt's "since the user's message" window
 *   reset at every gate nudge, so a finished run was told it "did not call
 *   any tools". A text-only user message now opens the window only when it is
 *   part of the request or a steer. No-file-write skips a file the run
 *   deleted. PATCH: a narrower trigger on an existing mechanism (agent eval
 *   reprompt firings 45→13 e4b, 52→25 ministral-3; SWE canary 88→35, F2P and
 *   resolve unchanged on 150 pairs).
 * - **5.1.12** (2026-10) — git_push goes where its approval says. It pushes
 *   to the branch's upstream remote (or a `remote` the call names), not
 *   always `origin`; `setUpstream` now sets one. The approval for git_push
 *   and for a shell `git push` names the remote's URL, whether the GitHub
 *   repo is public, the target branch, and the commits that would go up.
 *   PATCH: a parameter and description change on an existing tool.
 * - **5.1.10** (2026-10) — grep runs without grep on PATH. On Windows the
 *   grep tool falls back to the grep.exe Git for Windows ships in usr/bin
 *   (beside the git on PATH, then the standard install folders); with no
 *   grep anywhere it throws "grep is not installed… nothing was searched",
 *   pointing at `git grep`, instead of "Grep failed" or a false "No matches
 *   found". PATCH: an existing tool's executable lookup and error.
 * - **5.1.9** (2026-10) — a commit is looked at before it is made. git_commit
 *   and a shell `git commit` ask first, in every mode, when the commit would
 *   add copies of gitignored files, exceed 10 MB (or 5 MB in one file), add
 *   more than 500 files, or hold a path over 200 characters. PATCH: a new
 *   approval condition on existing tools. (5.1.6–5.1.8 were held for PRs
 *   still open when this merged, and are skipped.)
 * - **5.1.5** (2026-10) — project config the request didn't ask for needs
 *   approval (#351). Edits, writes and deletes of package manifests and
 *   compiler, lint, test-runner and Python config, and shell commands that
 *   rewrite them, ask in every mode unless the request names the file or that
 *   kind of change; a declined change tells the agent to finish without it.
 *   Agent eval: ministral-3 215/237 and gemma4:31b 233/237 on shared cases
 *   (baselines 215, 235); 8 unrequested edits declined, none needed. PATCH:
 *   a new approval guard on existing write tools.
 * - **5.1.4** (2026-10) — an edit written out as a fake tool result runs
 *   (#342). When a turn parses no text-form calls, an edit_file/write_file
 *   call whose arguments sit in a `<tool_output tool="…">` block is
 *   salvaged and run through the normal guards, behind the existing
 *   codeAsTextRecoveryEnabled flag. qwen2.5-coder:7b agent eval 142→147/237;
 *   ministral-3 and gemma4:31b never trigger it. PATCH: a new recovery
 *   shape inside existing text-form tool-call recovery.
 * - **5.1.3** (2026-10) — catch-up for guard, gate, reprompt and parser fixes
 *   merged 2026-10-22..28 without a bump: completion gate (#282 installs are
 *   not test runs, #283 a script that runs no test earns no credit, #325 no
 *   read/write demands for quoted or missing files); reprompts (#285, #303,
 *   #331); loop counting (#286 shell edits count as edits, #329 only applied
 *   edits spend edit_file's budget); edit_file (#330 CRLF no-op diagnosis,
 *   #336 dropped-import refusal, #343 a dropped-definition refusal only
 *   where the edit would write); tool-call parsing (#301, #333); grep (#322).
 *   PATCH: each tunes a firing condition or message inside an existing
 *   mechanism. Manifests stamped 5.1.2 from after 2026-10-21 may carry any of
 *   these; compare those runs by commit, not by version.
 * - **5.1.2** (2026-10) — iteration ceiling by tier (#237). When neither the
 *   caller nor the user sets one, the strong tier's default ceiling is 150
 *   (`maxIterations` in ScaffoldingProfile); medium and weak keep 50, pinned
 *   by scaffoldingProfileNeutrality.test.ts. An explicit
 *   `sidecar.agentMaxIterations`, a skill's own value, and the SWE harness's
 *   `SIDECAR_SWE_MAX_ITERS` all still win. Evidence: claude-haiku-4-5 hit 50 on
 *   32/50 SWE canary tasks and resolved 25/50; at 150 it resolved 30/50 with no
 *   run reaching 150. PATCH: a threshold within an existing mechanism.
 * - **5.1.1** (2026-10) — per-tool budgets are tiered (#236). The strong tier
 *   lifts run_command 15→60, read_file 25→50, grep/search_files 15→40,
 *   list_directory 10→20 (`toolBudgets` in ScaffoldingProfile); medium and
 *   weak keep the old values, pinned by scaffoldingProfileNeutrality.test.ts.
 *   A refusal no longer points at ask_user when no clarification UI can
 *   answer, and is recorded as a `tool_budget` decision. Evidence: the budget
 *   refused claude-haiku-4-5 in 40/50 SWE canary runs; with these values,
 *   15 calls in 8 runs, 31/50 resolved (neutral, McNemar p = 1.0). PATCH:
 *   thresholds and a reprompt string within an existing mechanism.
 * - **5.0.0** (2026-08) — checks must PASS, and silence is not an answer.
 *   MAJOR twice over: a gate's verification semantics changed and a new
 *   default-on mechanism was added.
 *   (1) Red-check completion gate: the gate verified that checks RAN, not
 *   that they PASSED — gemma4 ran tsc, saw both errors, called them
 *   "expected", and finished with a broken import. A failing verification
 *   result (shared isFailingCheckOutput predicate) now refuses completion,
 *   at most twice, with wording that lets an honest could-not-complete
 *   report exit; a new mutation stales the flag (the model is fixing) and
 *   the normal re-verification requirements re-arm it.
 *   (2) Empty-turn reprompt: a turn with no text and no tool call ended
 *   the run as 'natural' completion — three models recorded silent deaths
 *   right after a successful read. One bounded continue-reprompt; recurring
 *   silence still ends the run.
 *   Also in this batch (tool prompt surface): ask_user replies framed as
 *   "The user answered:" in the standard tool_output wrapper (bare-string
 *   replies were discounted — north-mini-code re-asked an answered
 *   question); search_files retries bare terms as name substrings and
 *   teaches names-vs-contents with a grep pointer; run_tests' no-runner
 *   hint is workspace-aware (tsc for TS, interpreter for Python, honest
 *   "no check available" otherwise); read_file on a directory names
 *   list_directory instead of leaking raw EISDIR.
 * - **4.0.4** (2026-08) — intent-aware reprompt escapes: run state over
 *   request phrasing. The action reprompt and fence coercion triggered on the
 *   REQUEST's shape (action verb + file path) with no awareness of what had
 *   already happened, so they fired on text-only turns that were the
 *   legitimate end of the work. Two evidence-keyed escapes: (1) a read-only
 *   request already answered from real, non-error read results — the text IS
 *   the deliverable; (2) a mutation followed by a CLEAN verification result —
 *   the text is a completion summary. A failing check (nonzero exit, error
 *   TS…, FAILED, Traceback) blocks escape (2) outright: v0.122 gemma4
 *   rationalized red tsc output and quit with a broken import, and nothing
 *   may make that exit easier. Deferred-intent text ("Next, I will…") keeps
 *   the reprompt regardless — announcing more work then stopping is still a
 *   stall. PATCH: firing-condition tuning within existing mechanisms.
 * - **4.0.3** (2026-08) — cycle detection distinguishes hammering from
 *   recovery. Three linked changes: (1) the consecutive-identical threshold
 *   is decoupled from cycleDetectionMinRepeats and fixed at 4 — defined as
 *   config+1, it had silently risen 4→11 when the normalized default went
 *   3→10, tolerance meant for varying-content retries applied to
 *   byte-identical resubmissions that can never self-correct; (2) a new
 *   identical-mutation pass counts byte-identical mutation calls ACROSS
 *   interleaved reads (gemma4 sent one failing edit 5× with reads between —
 *   longest streak 2, nothing fired); (3) length-2..4 pattern bails exempt
 *   the recovery shape (pattern includes a read of a file under active
 *   mutation — the exact behavior the edit errors prescribe), which
 *   previously died at 2 cycles, before edit_file's 3rd-failure escalation
 *   tier could run; the identical-mutation pass bounds the truly-stuck
 *   variant at 4. PATCH: threshold/exemption tuning within one mechanism.
 * - **4.0.2** (2026-08) — the "already done" signal disarms the act-now
 *   machinery. The action reprompt and fence-write coercion now stand down
 *   when the newest tool evidence is a "No change needed"/already-applied
 *   result (walking back past read-only results and synthetic injections,
 *   stopping at any real mutation or the user's actual request). Without this
 *   the two mechanisms fought the 4.0.1 messages: the model obeyed "if the
 *   task is complete, say so and finish", and its text-only completion turn
 *   triggered "No tool calls detected — re-prompting" plus a coerced write of
 *   its own summary fence — the exact loop the already-applied response exists
 *   to end. Marker predicate single-sourced (isNoChangeNeededResult) with the
 *   completion gate's no-op-edit bookkeeping. PATCH: firing-condition tuning
 *   within two existing mechanisms; no mechanism added, removed, or
 *   re-defaulted.
 * - **4.0.1** (2026-08) — landed-fix recognition in the rewrite guards.
 *   `isEditAlreadyApplied` gains an exact-outcome signal (replacement present
 *   verbatim exactly once + search gone ⇒ "already applied") — the token
 *   heuristic compares identifier sets, so an operator-only edit (`a < b` →
 *   `a >= b`) could never be recognized as landed and read as "search string
 *   not found" forever. The enforce-edit-over-rewrite guard now confirms "no
 *   change needed" when the write content is identical (modulo CRLF/trailing
 *   newline) to the file's current state, instead of a clobber lecture about
 *   content that clobbers nothing. Evidence: gemma4:e4b burned 14 iterations
 *   re-fixing an already-correct minmax.ts (fix-wrong-comparison-operator,
 *   2026-08-02 and 2026-08-05). PATCH: recognition tuning within existing
 *   guards; no mechanism added, removed, or re-defaulted.
 * - **4.0.0** (2026-07) — edit_file collapses to ONE operation. insert_before /
 *   insert_after / new_text and the V2 insert convention are removed, along with
 *   the splitFusedAnchor recovery. The field names contradicted their semantics
 *   (`insert_after` documented as the payload, read by models as a position) and
 *   V1 declared no field for the payload at all, so the intent was inexpressible.
 *   Measured on gemma4 (3 reps, frozen code): ten pathological events under the
 *   V1 insert surface — eight bounces for a dropped `path`, eight fused-anchor
 *   "recoveries" that reported File edited while duplicating text five times —
 *   and ZERO under V2. Rather than ship the naming fix, the surface is gone:
 *   insertion is now the industry-standard idiom (anchor in `search`, anchor
 *   repeated in `replace`), matching Claude Code, Aider, Cline and apply_patch.
 *   MAJOR because a mechanism was removed and the repair path changed.
 * - **2.0.0** (2026-07) — verification-vertical + do-no-harm generation. Adds
 *   the keep-best ratchet (Pareto-safe scaffolding), mutation testing, the §5
 *   analytic-bound gate + property-based test synthesis, the prompt-injection
 *   guard, and strengthened tier-1 tool-call repair (raw-control-char escaping).
 *   NOTE: the new gates default OFF and are not yet in the ablation `arms.ts`
 *   `scaffold-on` set — a `scaffold-on` run at 2.0.0 measures the SAME mechanisms
 *   as 1.x unless the arm config opts them in. The version differs because the
 *   SHARED path (repair, gate internals) changed.
 * - **1.x** — pre-2026-07 baseline (completion gate, auto-fix, adaptive
 *   scaffolding, impact gate, numerical-contract gate).
 */

export const SCAFFOLD_VERSION = '7.0.24';

/** Config-like shape `describeScaffold` reads — a partial SideCarConfig or an
 *  ablation arm's merged override. All optional; defaults mirror settings.ts. */
export interface ScaffoldConfigLike {
  completionGateEnabled?: boolean;
  autoFixOnFailure?: boolean;
  adaptiveScaffoldingEnabled?: boolean;
  impactGateEnabled?: boolean;
  numericalContractGateEnabled?: boolean;
  analyticBoundsGateEnabled?: boolean;
  keepBestRatchetEnabled?: boolean;
  scratchCleanupEnabled?: boolean;
  injectionGuardEnabled?: boolean;
  diagnosticsReactiveFixEnabled?: boolean;
}

export interface ScaffoldDescriptor {
  version: string;
  /** Which scaffolding mechanisms were active. Order-stable for diffing. */
  features: Record<string, boolean>;
}

/** Snapshot the active scaffold from a config/arm. `completionGate`,
 *  `injectionGuard`, `adaptiveScaffolding`, `keepBestRatchet` and
 *  `scratchCleanup` default ON
 *  (mirroring settings.ts); the rest default OFF.
 *
 *  These defaults MUST track settings.ts. `adaptiveScaffolding` read an absent
 *  field as `false` until its real default flipped to `true` — which would have
 *  stamped `adaptiveScaffolding: false` into every run manifest of a run that was
 *  actually using it. A scaffold snapshot that misreports the scaffold defeats the
 *  entire purpose of versioning it. */
export function describeScaffold(cfg: ScaffoldConfigLike): ScaffoldDescriptor {
  return {
    version: SCAFFOLD_VERSION,
    features: {
      completionGate: cfg.completionGateEnabled !== false,
      autoFix: cfg.autoFixOnFailure === true,
      adaptiveScaffolding: cfg.adaptiveScaffoldingEnabled !== false,
      impactGate: cfg.impactGateEnabled === true,
      numericalContractGate: cfg.numericalContractGateEnabled === true,
      analyticBoundsGate: cfg.analyticBoundsGateEnabled === true,
      keepBestRatchet: cfg.keepBestRatchetEnabled !== false,
      scratchCleanup: cfg.scratchCleanupEnabled !== false,
      injectionGuard: cfg.injectionGuardEnabled !== false,
      diagnosticsReactiveFix: cfg.diagnosticsReactiveFixEnabled === true,
    },
  };
}

/** Compact one-line label, e.g. `scaffold 2.0.0 [completionGate,autoFix]`. */
export function scaffoldLabel(desc: ScaffoldDescriptor): string {
  const on = Object.entries(desc.features)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return `scaffold ${desc.version} [${on.join(',') || 'bare'}]`;
}
