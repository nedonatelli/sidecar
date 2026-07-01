# SWE-bench ablation — cloud runbook

Run the whole campaign on **one GPU + Docker box** so it doesn't tie up your
laptop: pull the model → fetch a deterministic task slice → generate
scaffold-off vs scaffold-on predictions → score both with the official
`swebench` Docker harness → compute the lift. One command:

```bash
git clone <this repo> && cd ollama-vscode
MODEL=qwen2.5-coder:7b N=50 DATASET=SWE-bench_Lite bash bench/swe/cloud/run_campaign.sh
# → swe_campaign_<ts>/ablation.md  (resolve% per arm + lift + rescued/regressed)
```

## Why a cloud box (and not the laptop)

Two needs collide: a **GPU** (Ollama running the small model for prediction
generation) and **Docker** (the swebench scorer builds/pulls a per-repo image
per task and runs its tests). One box with both does the lot.

## Recommended provider

**RunPod** — the best fit for this: rent a GPU _pod_ (Docker-native, pay per
hour), one box does prediction-gen _and_ scoring. A ~24 GB-VRAM card (A40 /
A5000 / A6000) is plenty for a 7B model and costs roughly **$0.30–0.80/hr**; a
50-task Lite campaign (predict + score) is a few hours ≈ **a few dollars**.
Configure **≥150 GB disk** — swebench images are large.

**Vast.ai** — the chosen provider. Cheapest GPU marketplace. **Key gotcha:** a
Vast instance is itself a container, and the swebench scorer needs to run Docker
(it builds/runs a per-task image). So either rent a **Docker-in-Docker /
privileged-enabled** instance (some templates support it) for the scoring step,
**or** split it: prediction-gen on the Vast GPU box, scoring via **Modal**
(`--modal true`, serverless — no Docker-in-Docker headache). Pick a
high-reliability host; configure ≥150 GB disk.

Alternatives:

- **RunPod** — GPU pod, template-deploy in ~1 min, one box does predict + score.
- **Modal** — native `--modal true` scoring backend, serverless (no Docker box);
  pair with any GPU for the prediction step.
- **Lambda Cloud** — clean GPU VMs; Docker-in-Docker for swebench can need extra setup.

Big clouds (AWS/GCP/Azure GPU VMs) work but are more setup + cost for the same job.

## Box requirements

- NVIDIA GPU, **≥12 GB VRAM** (a 7B model; more headroom is fine)
- **Docker** (running; the scorer needs it)
- **≥150 GB disk** (swebench per-repo images)
- git, **Node 20+**, **Python 3.11+**
- Ubuntu 22.04 is the path of least resistance

## Knobs (env vars)

| var           | default            | meaning                                          |
| ------------- | ------------------ | ------------------------------------------------ |
| `MODEL`       | `qwen2.5-coder:7b` | Ollama model (the small coding base)             |
| `N`           | `50`               | task count (the deterministic stride slice)      |
| `DATASET`     | `SWE-bench_Lite`   | or `SWE-bench_Verified`                          |
| `MAX_ITERS`   | `30`               | agent iteration cap per task                     |
| `SWE_WORKERS` | `4`                | swebench Docker parallelism (raise on big boxes) |

## Notes / gotchas

- **Reproducible slice:** `fetch_dataset.mjs` sorts by `instance_id` and stride-
  samples, so the same `N` yields the same tasks on any machine (the envelope
  requires this). It needs no shipped data — it pulls from the HF datasets-server.
- **The report path:** `run_evaluation` writes a `<model>.<run_id>.json` with
  `resolved_ids`; the script copies it to `resolved.<arm>.json`. swebench versions
  move this around — if the ablate step can't find it, locate the report json the
  harness printed and copy it to `resolved.<arm>.json` yourself, then re-run step 5.
- **Cost control:** start with `N=50` on `SWE-bench_Lite` to validate the pipeline
  end-to-end before scaling to the full set. Kill the pod when done.
- **Honest expectation:** a 7B model lands single-to-low-double-digit resolve%
  absolute — the headline is the on/off **lift** and the local/zero-API-cost story,
  not parity with a frontier model.
