#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SWE-bench ablation on a Mac. No GPU box.
#
# Predictions run on your local Ollama, or on a cloud API with PROVIDER set;
# the official swebench scorer runs the hidden tests in the per-task eval
# images under local Docker (amd64 via Rosetta on Apple Silicon), through
# score_local.sh. A run reuses a committed task slice + a local repo cache;
# scoring pulls the eval images and the SWE-bench/SWE-bench_Lite metadata.
#
# One-time setup:
#   1. Ollama installed and the model pulled (the script pulls if missing),
#      or an API key for PROVIDER.
#   2. Docker with amd64 emulation, e.g.
#        brew install docker colima
#        colima start --cpu 6 --memory 12 --disk 120 --vm-type vz --vz-rosetta
#      Each eval image is ~1.6 GB unique; N=50 needs ~80 GB of colima disk.
#
# Usage (from repo root):
#   npm run bench:swe:local                                   # gemma4:e4b, 20 tasks
#   MODEL=qwen2.5-coder:7b N=50 npm run bench:swe:local       # full slice
#   PROVIDER=anthropic MODEL=claude-haiku-4-5-20251001 N=50 npm run bench:swe:local
#   ARMS=scaffold-on MAX_ITERS=150 ... npm run bench:swe:local  # one arm, higher ceiling
#
# Keep the machine on AC power with the lid OPEN. The script holds off idle,
# disk and system sleep itself, but nothing stops a lid close, and every
# per-task timer is wall-clock: a sleeping Mac turns in-flight requests into
# timeouts and empty patches that read as model failures (2026-10-20).
#
# Result: $WORK/ablation.md (the harness lift, per-arm resolve rates, CI). A
# single-arm run stops after scoring: there is no lift to compute.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -z "${SWE_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null; then
  SWE_CAFFEINATED=1 exec caffeinate -dimsu "$0" "$@"
fi

PROVIDER="${PROVIDER:-ollama}"
MODEL="${MODEL:-gemma4:e4b}"
N="${N:-20}"
SLICE="${SLICE:-bench/swe/data/canary.jsonl}"
ARMS="${ARMS:-scaffold-off,scaffold-on}"
# The shipped sidecar.agent.maxIterations.
MAX_ITERS="${MAX_ITERS:-50}"
# Per-task ceiling, ms. Was hardcoded at 300_000 (5 min), which silently
# truncated most scaffolded arms: measured gate-only arms legitimately run
# 673–1202s on django tasks, so a 5-minute cap made this script's results
# non-comparable to the documented runs. Now configurable, defaulting to 20 min.
# This is a HANG guard, not a work budget — raise it freely when debugging.
TASK_TIMEOUT="${TASK_TIMEOUT:-1200000}"
CACHE="${SIDECAR_SWE_REPO_CACHE:-.sidecar/cache/swe-repos}"
WORK="${WORK:-.sidecar/cache/swe-local/run_$(date +%Y%m%d_%H%M%S)}"
PRED="$WORK/predictions"
mkdir -p "$PRED" "$CACHE"

if [ "$PROVIDER" = ollama ]; then
  echo "== [1/5] ollama =="
  command -v ollama >/dev/null || { echo "!! ollama not installed — https://ollama.com/download"; exit 1; }
  curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 \
    || { echo "  starting ollama…"; (ollama serve >"$WORK/ollama.log" 2>&1 &) ; sleep 5; }
  ollama list | awk '{print $1}' | grep -qx "$MODEL" || ollama pull "$MODEL"
  export SIDECAR_SWE_PROVIDER=ollama
else
  echo "== [1/5] provider $PROVIDER =="
  # The driver sends every request to OLLAMA_HOST whatever the provider, so a
  # cloud run must point it at the API. There is no model cache to cold-start.
  case "$PROVIDER" in
    anthropic) BASE_URL="${BASE_URL:-https://api.anthropic.com}"; API_KEY="${API_KEY:-${ANTHROPIC_API_KEY:-}}" ;;
    *) BASE_URL="${BASE_URL:?set BASE_URL for provider $PROVIDER}"; API_KEY="${API_KEY:-}" ;;
  esac
  [ -n "$API_KEY" ] || { echo "!! no API key — set API_KEY (or ANTHROPIC_API_KEY)"; exit 1; }
  export SIDECAR_SWE_PROVIDER="$PROVIDER" SIDECAR_SWE_API_KEY="$API_KEY" OLLAMA_HOST="$BASE_URL" \
    SIDECAR_SWE_WARM_MODEL=1
fi

echo "== [2/5] repo cache ($CACHE) =="
# Full clones (all blobs) so swe.eval.ts can `reset --hard <base>` offline per
# task. Idempotent — clones only what's missing. Only repos the selected N
# tasks touch are cloned (sampleTasks sorts by instance_id, takes first N).
repos=$(python3 - "$SLICE" "$N" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rows.sort(key=lambda r: r["instance_id"])
seen = []
for r in rows[: int(sys.argv[2])]:
    if r["repo"] not in seen:
        seen.append(r["repo"])
print("\n".join(seen))
PY
)
for repo in $repos; do
  dir="$CACHE/${repo//\//_}"
  if [ ! -d "$dir/.git" ]; then
    echo "  clone $repo"
    git clone --quiet "https://github.com/$repo.git" "$dir"
  fi
done

echo "== [3/5] predictions (provider=$PROVIDER, model=$MODEL, N=$N, arms=$ARMS, max_iters=$MAX_ITERS) =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_MODEL="$MODEL" \
  SIDECAR_SWE_OUT="$PRED" SIDECAR_SWE_MAX_ITERS="$MAX_ITERS" SIDECAR_SWE_ARMS="$ARMS" \
  SIDECAR_SWE_REPO_CACHE="$CACHE" \
  SIDECAR_SWE_TASK_TIMEOUT="$TASK_TIMEOUT" SIDECAR_SWE_TIMEOUT=360000000 \
  npm run bench:swe:predict 2>&1 | tee "$WORK/predict.log"

echo "== [4/5] scoring (local Docker) =="
preds=()
for arm in ${ARMS//,/ }; do preds+=("$PRED/preds.$arm.jsonl"); done
bash bench/swe/local/score_local.sh "$WORK" sidecar-local "${preds[@]}"

case ",$ARMS," in
  *,scaffold-on,*scaffold-off,* | *,scaffold-off,*scaffold-on,*) ;;
  *) echo "== done (single arm, no lift) → $WORK/resolved.*.json =="; exit 0 ;;
esac

echo "== [5/5] ablation lift =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_PREDS="$PRED" \
  SIDECAR_SWE_RESOLVED_ON="$WORK/resolved.scaffold-on.json" \
  SIDECAR_SWE_RESOLVED_OFF="$WORK/resolved.scaffold-off.json" \
  SIDECAR_SWE_HARNESS_VERSION="$("${SWE_VENV:-.sidecar/cache/swe-venv}/bin/python" -c 'import swebench; print(swebench.__version__)')" \
  SIDECAR_SWE_OUT="$WORK" \
  npm run bench:swe:ablate 2>&1 | tee "$WORK/ablation.log"

echo "== done → $WORK/ablation.md =="
