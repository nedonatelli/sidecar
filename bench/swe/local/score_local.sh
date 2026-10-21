#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Score SWE-bench predictions with the official swebench harness in local
# Docker. Works for any agent's predictions (SideCar arms, the baselines in
# ../baselines/), so every number in a comparison comes from one scorer.
#
# Usage (from repo root):
#   bench/swe/local/score_local.sh <work_dir> <run_prefix> <preds.LABEL.jsonl>...
#
# Writes <work_dir>/resolved.LABEL.json and score.LABEL.log per predictions
# file, where LABEL is the file name minus `preds.` and `.jsonl`.
#
# Needs Docker with amd64 emulation (see README.md). Scoring used to run on
# Modal; swebench's Modal evaluator calls Modal's retired legacy Sandbox
# filesystem API, so every instance errors at sandbox creation.
# ---------------------------------------------------------------------------
set -euo pipefail
[ $# -ge 3 ] || { sed -n '8,9p' "$0"; exit 2; }
cd "$(git rev-parse --show-toplevel)"
mkdir -p "$1"
WORK="$(cd "$1" && pwd)"
PREFIX="$2"
shift 2
PREDS=()
for p in "$@"; do PREDS+=("$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"); done
VENV="$PWD/${SWE_VENV:-.sidecar/cache/swe-venv}"

docker run --rm --platform linux/amd64 alpine uname -m 2>/dev/null | grep -qx x86_64 \
  || { echo "!! Docker with amd64 emulation not available — see bench/swe/local/README.md"; exit 1; }
if [ ! -d "$VENV" ]; then python3 -m venv "$VENV"; "$VENV/bin/pip" install -q --upgrade pip >/dev/null; fi
# swebench 5.x: 4.x's run_evaluation does not read the image/eval_script fields
# the SWE-bench/* datasets now carry.
"$VENV/bin/python" -c 'import swebench, sys; sys.exit(int(swebench.__version__.split(".")[0]) < 5)' 2>/dev/null \
  || "$VENV/bin/pip" install -q 'swebench>=5'

# The harness pulls with the host's platform and 404s on arm64; pre-pull amd64.
# It reuses any image already present.
python3 - "${PREDS[@]}" <<'PY' | sort -u | while read -r img; do
import json, sys
for path in sys.argv[1:]:
    for line in open(path):
        if line.strip():
            iid = json.loads(line)["instance_id"]
            print(f"swebench/sweb.eval.x86_64.{iid.replace('__', '_1776_')}:latest".lower())
PY
  docker image inspect "$img" >/dev/null 2>&1 || docker pull --quiet --platform linux/amd64 "$img" >/dev/null \
    || echo "!! pull failed: $img"
done

cd "$WORK"
for preds in "${PREDS[@]}"; do
  label=$(basename "$preds" .jsonl)
  label=${label#preds.}
  echo "== score $label =="
  # SWE-bench/ namespace, not princeton-nlp/*: swebench 5.x needs the
  # per-instance image fields only the former carries.
  "$VENV/bin/python" -m swebench.harness.run_evaluation \
    --dataset_name SWE-bench/SWE-bench_Lite --split test \
    --predictions_path "$preds" --run_id "$PREFIX-$label" \
    --max_workers "${SWE_WORKERS:-4}" > "score.$label.log" 2>&1 || echo "!! score $label exited $?"
  report=$(ls -t ./*."$PREFIX-$label".json 2>/dev/null | head -1 || true)
  if [ -n "$report" ]; then
    cp "$report" "resolved.$label.json"
    python3 -c "
import json, sys
r = json.load(open(sys.argv[1]))
print(sys.argv[2], {k: r[k] for k in ('submitted_instances', 'completed_instances', 'resolved_instances', 'error_instances', 'empty_patch_instances')})
" "resolved.$label.json" "$label"
  else
    echo "!! no report for $label — check $WORK/score.$label.log"
  fi
done
