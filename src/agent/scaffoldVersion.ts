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

export const SCAFFOLD_VERSION = '5.1.18';

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
  injectionGuardEnabled?: boolean;
  diagnosticsReactiveFixEnabled?: boolean;
}

export interface ScaffoldDescriptor {
  version: string;
  /** Which scaffolding mechanisms were active. Order-stable for diffing. */
  features: Record<string, boolean>;
}

/** Snapshot the active scaffold from a config/arm. `completionGate`,
 *  `injectionGuard`, `adaptiveScaffolding` and `keepBestRatchet` default ON
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
