---
title: Research Assistant
layout: docs
nav_order: 2
nav_section: 'Extend'
---

# Research Assistant

The Research Assistant (v0.104+) provides structured, hypothesis-driven project tracking for engineering and scientific workflows inside VS Code. It is not a note-taking layer on top of the agent — it is an opinionated workflow: you state a research question, commit to falsifiable hypotheses, run reproducible experiments, record observations, and generate a report. Everything persists in `.sidecar/research/` and is tracked in git alongside your code.

---

## Enabling

Add to your workspace settings (`.vscode/settings.json`) or user settings:

```json
{
  "sidecar.research.enabled": true
}
```

This registers eight agent tools and activates the Research sidebar panel. The setting is `false` by default; attempting to call any research tool while disabled returns a message directing you to enable it.

---

## Core workflow

### 1. Create a project

Either ask the agent in chat:

```
Create a research project titled "FIR vs Wavelet Transient Detection" with the question:
"Does wavelet decomposition outperform FFT for detecting sub-cycle transients in power-line signals?"
```

Or click the **+** button in the Research sidebar panel and fill in the title and question prompts.

The project is written to `.sidecar/research/fir-vs-wavelet-transient-detection/project.yaml`. The slug is derived from the title (lowercase, hyphens, max 60 characters) and is used in every subsequent tool call.

### 2. Add hypotheses

```
Add a hypothesis to fir-vs-wavelet-transient-detection:
"Daubechies-4 wavelet at level 3 will achieve F1 > 0.9 on the IEEE transient dataset at SNR = 20 dB."
```

Each hypothesis gets a generated ID (e.g. `h-1748000000000-a3f2`) and starts with status `open`. You can add as many hypotheses as the project demands.

### 3. Log experiments

```
Log an experiment for fir-vs-wavelet-transient-detection:
  id: exp-2026-05-wavelet-l3-snr20
  command: python scripts/eval.py --method wavelet --level 3 --snr 20
  parameters: {method: wavelet, level: 3, snr_db: 20}
  seed: 42
```

`research_log_experiment` requires approval before running (the command executes in your shell). It writes a manifest, runs the command, captures the last 30 lines of stdout (capped at 2,000 characters), and saves the result to `.sidecar/research/<slug>/experiments/<id>/manifest.yaml`. Exit code 0 marks the experiment `complete`; anything else marks it `abandoned`.

### 4. Record observations

Observations are timestamped free-text notes — use them for anything not captured in experiment output: anomalies you noticed, decisions about method changes, references you read.

```
Add an observation to fir-vs-wavelet-transient-detection:
"Level 3 decomposition saturates on 50-Hz harmonics — level 4 may be necessary for harmonics above the 3rd."
```

Each observation is saved as a separate `.md` file under `observations/` with a Unix-timestamp filename.

### 5. Update hypothesis status

Once you have experimental evidence, close the loop:

```
Update hypothesis h-1748000000000-a3f2 in fir-vs-wavelet-transient-detection to: supported
```

Valid statuses are `open`, `supported`, `refuted`, `needs-more-evidence`, and `abandoned`. The project's `updatedAt` timestamp is refreshed on every write.

### 6. Generate a report

```
/research report fir-vs-wavelet-transient-detection
```

Or ask the agent:

```
Export a research report for fir-vs-wavelet-transient-detection
```

The report is written to `.sidecar/research/<slug>/report.md` and returned inline in chat. It contains:

- A hypothesis outcomes table (ID, text, status)
- An experiments summary table followed by per-experiment sections with collapsible output blocks
- A chronological observations timeline

---

## The `/research` slash command

Type `/research` in the chat input to:

- **Set the active project** — `sidecar.research.activeProject` is updated; subsequent bare research requests default to this project.
- **Log an observation** — `research add observation` quick-entry without a full agent turn.
- **Generate a report** — `/research report <slug>`.

---

## The eight agent tools

| Tool                                | Approval required | What it does                                                                                 |
| ----------------------------------- | :---------------: | -------------------------------------------------------------------------------------------- |
| `research_create_project`           |        No         | Creates a new project directory and `project.yaml`. Returns the slug.                        |
| `research_add_hypothesis`           |        No         | Appends a hypothesis (status `open`) to `project.yaml`. Returns the hypothesis ID.           |
| `research_log_experiment`           |      **Yes**      | Writes a manifest, runs the shell command, captures output, marks `complete` or `abandoned`. |
| `research_add_observation`          |        No         | Appends a timestamped `.md` note to `observations/`.                                         |
| `research_update_hypothesis_status` |        No         | Sets a hypothesis to `open`, `supported`, `refuted`, `needs-more-evidence`, or `abandoned`.  |
| `research_set_project_status`       |        No         | Sets the project to `active`, `paused`, `complete`, or `abandoned`.                          |
| `research_list_projects`            |        No         | Returns all projects with slug, title, status, hypothesis count, and age.                    |
| `research_export_report`            |        No         | Generates and writes `report.md`; returns the full markdown.                                 |

`research_log_experiment` is the only tool that executes shell commands, which is why it requires explicit approval.

---

## The Research sidebar

The **Research** panel in the VS Code sidebar (view ID `sidecar.research`) shows a live tree:

```
beaker  FIR vs Wavelet Transient Detection   active
  lightbulb  Hypotheses  2
    h-1748…-a3f2   supported
    h-1748…-b8e1   open
  microscope  Experiments  3
    exp-2026-05-wavelet-l3-snr20   complete
    exp-2026-05-fft-baseline       complete
    exp-2026-05-wavelet-l4-snr20   running  ⟳
  note  Observations  4
    May 23, 14:32   Level 3 decomposition saturates…
```

Clicking an experiment node opens its `manifest.yaml`. Clicking an observation node opens the `.md` file.

The sidebar auto-refreshes with a 500 ms debounce whenever any file under `.sidecar/research/**` changes — so you see results appear as the agent writes them without manual refresh. You can also trigger a manual refresh with `SideCar: Refresh Research View` from the Command Palette or the refresh icon in the panel header.

---

## Generating reports

### Via slash command

```
/research report <slug>
```

### Via the agent

```
Export a research report for my active research project
```

### Report structure

```markdown
# Research Report: FIR vs Wavelet Transient Detection

**Question:** Does wavelet decomposition outperform FFT for detecting sub-cycle transients?
**Status:** active
**Generated:** 2026-05-30 09:14 UTC

---

## Hypotheses

| ID             | Hypothesis                                     | Status    |
| -------------- | ---------------------------------------------- | --------- |
| `h-1748…-a3f2` | Daubechies-4 at level 3 will achieve F1 > 0.9… | supported |

---

## Experiments

| ID                             | Command                                     | Status   | Exit |
| ------------------------------ | ------------------------------------------- | -------- | ---- |
| `exp-2026-05-wavelet-l3-snr20` | `python scripts/eval.py --method wavelet …` | complete | 0    |

### exp-2026-05-wavelet-l3-snr20

**Command:** `python scripts/eval.py --method wavelet --level 3 --snr 20`
**Parameters:** `{"method":"wavelet","level":3,"snr_db":20}`
**Seed:** 42

<details>
<summary>Output (last 30 lines)</summary>
```

F1: 0.923 Precision: 0.941 Recall: 0.906

```

</details>

---

## Observations
…
```

The report file is committed alongside your code if you run `git add .sidecar/research/`.

---

## Combining with other features

### PDF indexing and literature retrieval

Index papers before starting experiments so the agent can ground its interpretation in the literature:

```
index_pdf path="papers/mallat-1989-wavelet.pdf"
index_pdf path="papers/ieee-transient-benchmark-2021.pdf"
```

Enable literature retrieval in settings:

```json
{
  "sidecar.literature.enabled": true
}
```

Once indexed, the agent can call `project_knowledge_search` to pull relevant passages when interpreting experiment results or writing observations. Combine this with research tools in a single agent turn — for example: run an experiment, search the literature for the closest prior result, and record an observation that cites both.

### Zotero integration

If your reference library is in Zotero, configure the connection:

```json
{
  "sidecar.zotero.userId": "1234567",
  "sidecar.zotero.apiKey": "your-read-only-key"
}
```

The agent can then call `zotero_search` to find papers by keyword or author and `zotero_get_item` to retrieve metadata and abstract. Use this to back observations with proper citations rather than just notes:

```
Search Zotero for "Daubechies wavelet filter bank" and record the top result as an observation in fir-vs-wavelet-transient-detection
```

### Notebook Mode for source-grounded briefings

Notebook Mode (`sidecar.notebookMode.enabled: true`, enter with `/notebook`) and the Research Assistant serve different purposes but complement each other:

- Use **Notebook Mode** to synthesize ingested source material into a structured briefing, FAQ, or study guide before you commit to hypotheses.
- Use the **Research Assistant** once you have a question and are running experiments.

A typical flow: `/notebook` → `ingest_source` a handful of papers → `generate_briefing` to understand the landscape → `/code` → form hypotheses in the Research Assistant → run experiments.

---

## Worked examples

### Example 1: Algorithm performance comparison

**Goal:** Determine whether a custom bitonic sort outperforms `std::sort` on GPU-resident integer arrays.

```
Create a research project "Bitonic vs std::sort GPU" with the question:
"Does a custom bitonic sort implementation outperform std::sort on CUDA integer arrays of size 2^24?"
```

```
Add hypotheses to bitonic-vs-std-sort-gpu:
1. "Custom bitonic sort will be at least 2x faster than std::sort at N=2^24 on an A100."
2. "The performance gap will narrow below N=2^20 due to kernel launch overhead."
```

```
Log experiment bitonic-vs-std-sort-gpu:
  id: exp-baseline-std-sort
  command: ./bench --method std_sort --n 16777216 --trials 100
  parameters: {method: std_sort, n: 16777216}
  seed: 0
```

```
Log experiment bitonic-vs-std-sort-gpu:
  id: exp-bitonic-n24
  command: ./bench --method bitonic --n 16777216 --trials 100
  parameters: {method: bitonic, n: 16777216}
  seed: 0
```

After reviewing the output:

```
Update hypothesis h-<id-1> in bitonic-vs-std-sort-gpu to: supported
Add observation to bitonic-vs-std-sort-gpu:
"Bitonic: 14.2ms mean, std 0.3ms. std::sort: 31.8ms mean, std 0.5ms. Ratio 2.24x — hypothesis 1 supported.
At N=2^20 the ratio drops to 1.3x, consistent with hypothesis 2."
```

```
/research report bitonic-vs-std-sort-gpu
```

The report goes into `.sidecar/research/bitonic-vs-std-sort-gpu/report.md` and can be attached to the PR that ships the implementation.

---

### Example 2: Architecture decision tracking

**Goal:** Evaluate whether replacing a polling-based file watcher with `inotify` reduces CPU overhead enough to justify the migration cost.

```
Create a research project "Watcher Migration: poll vs inotify" with the question:
"Does replacing the polling file watcher with inotify reduce idle CPU overhead by more than 50% without regressing watch latency?"
```

```
Add hypotheses to watcher-migration-poll-vs-inotify:
1. "inotify idle CPU usage will be < 0.1% vs poll baseline of ~2% on a 10k-file workspace."
2. "Watch latency (time-to-first-event) will stay under 50ms for both implementations."
3. "The migration will require changes to fewer than 200 lines across the affected modules."
```

No shell command can measure decision complexity, so log a planning experiment manually:

```
Log experiment watcher-migration-poll-vs-inotify:
  id: exp-scope-estimate
  command: git diff --stat HEAD~5 -- src/watcher/
  parameters: {scope: initial_estimate}
```

After a spike:

```
Add observation to watcher-migration-poll-vs-inotify:
"Spike complete. inotify wrapper is 87 lines. Adapter for Windows (ReadDirectoryChangesW) adds 110 lines.
Total estimate: ~200 lines. Hypothesis 3 is on the boundary — flag as needs-more-evidence until final diff."
```

```
Log experiment watcher-migration-poll-vs-inotify:
  id: exp-cpu-idle-poll
  command: python scripts/cpu_sample.py --impl poll --workspace fixtures/10k-files --duration 30
  parameters: {impl: poll, workspace_size: 10000, duration_s: 30}
  seed: 1
```

```
Log experiment watcher-migration-poll-vs-inotify:
  id: exp-cpu-idle-inotify
  command: python scripts/cpu_sample.py --impl inotify --workspace fixtures/10k-files --duration 30
  parameters: {impl: inotify, workspace_size: 10000, duration_s: 30}
  seed: 1
```

```
Update hypothesis h-<id-1> in watcher-migration-poll-vs-inotify to: supported
Update hypothesis h-<id-2> in watcher-migration-poll-vs-inotify to: supported
Update hypothesis h-<id-3> in watcher-migration-poll-vs-inotify to: needs-more-evidence
```

```
research_set_project_status watcher-migration-poll-vs-inotify: complete
/research report watcher-migration-poll-vs-inotify
```

The generated report documents the decision rationale with reproducible benchmark commands, parameter logs, and a clear hypothesis outcome table — suitable for a team ADR or architecture review.

---

## Storage layout

```
.sidecar/research/
  <slug>/
    project.yaml              # ResearchProject JSON (hypotheses embedded)
    report.md                 # Latest generated report (overwritten on each export)
    experiments/
      <exp-id>/
        manifest.yaml         # ExperimentManifest JSON
    observations/
      <timestamp>.md          # One file per observation
```

The top-level `.sidecar/` directory is tracked by git. The `research/` subtree inside it is included by default — commit it to preserve your project history and share it with collaborators. If you want to exclude it, add `.sidecar/research/` to `.gitignore`.
