#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# mini-SWE-agent on a SWE-bench slice -> official predictions JSONL.
#
# The SWE-bench team's minimal reference agent (one bash tool), run at its
# standard swebench.yaml settings (250 steps, $3/task cap) inside SWE-bench's own
# Docker images on Modal (swe-rex; this path works, unlike swebench's Modal
# *evaluator*). Score the output with bench/swe/local/score_local.sh.
#
# Usage (from repo root):
#   bench/swe/baselines/mini_swe.sh <out_dir>
# Env: MODEL (anthropic/claude-haiku-4-5-20251001, any LiteLLM id), SLICE
# (canary), WORKERS (4). Needs Modal auth (`modal token set`) and the model's API
# key. Writes <out_dir>/preds.mini.jsonl.
#
# Tasks that die on infrastructure (DNS, Modal stream, timeouts) are rerun once
# into <out_dir>/rerun and merged: 27/50 died that way on 2026-10-20, and
# counting them as unresolved would understate the agent badly. Keep the host
# awake — see bench/swe/local/run_local.sh.
# ---------------------------------------------------------------------------
set -euo pipefail
[ $# -eq 1 ] || { sed -n '11,12p' "$0"; exit 2; }
cd "$(git rev-parse --show-toplevel)"
if [ -z "${SWE_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null; then
  SWE_CAFFEINATED=1 exec caffeinate -dimsu "$0" "$@"
fi
OUT="$1"
MODEL="${MODEL:-anthropic/claude-haiku-4-5-20251001}"
SLICE="${SLICE:-bench/swe/data/canary.jsonl}"
VENV="${MINI_VENV:-.sidecar/cache/mini-swe/venv}"
mkdir -p "$OUT"

if [ ! -x "$VENV/bin/mini-extra" ]; then
  python3 -m venv "$VENV"
  # mcp: LiteLLM's Anthropic path imports it, and without it every call fails
  # with ModuleNotFoundError after the first request.
  "$VENV/bin/pip" install -q 'mini-swe-agent[modal]' swe-rex mcp
fi

# The slice's instance ids as one anchored regex. The run pulls the HF `lite`
# subset (mini-extra cannot load a bare JSONL) and filters it to the slice.
ids_regex() {
  python3 - "$@" <<'PY'
import json, sys
ids = sorted(json.loads(l)["instance_id"] for l in open(sys.argv[1]) if l.strip()) if len(sys.argv) == 2 else sys.argv[2:]
print("^(" + "|".join(ids) + ")$")
PY
}

run() {  # run <filter-regex> <output-dir> <workers>
  "$VENV/bin/mini-extra" swebench --subset lite --split test --filter "$1" \
    -c swebench.yaml -c swebench_modal.yaml \
    -c "model.model_name=$MODEL" -c model.model_class=litellm \
    -o "$2" -w "$3" > "$2.log" 2>&1
}

run "$(ids_regex "$SLICE")" "$OUT/main" "${WORKERS:-4}"

# Statuses that mean the task never got a fair run.
infra=$(python3 - "$OUT"/main/exit_statuses_*.yaml <<'PY'
import re, sys
INFRA = {"ConnectionError", "TimeoutError", "StreamTerminatedError", "gaierror"}
cur = None
for line in open(sys.argv[1]):
    if m := re.match(r"    (\w+):$", line):
        cur = m.group(1)
    elif (m := re.match(r"    - (\S+)", line)) and cur in INFRA:
        print(m.group(1))
PY
)
if [ -n "$infra" ]; then
  echo "== rerunning $(echo "$infra" | wc -l | tr -d ' ') infra-failed tasks =="
  # shellcheck disable=SC2086
  run "$(ids_regex - $infra)" "$OUT/rerun" 2
fi

python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
preds = json.load(open(f"{out}/main/preds.json"))
rerun = f"{out}/rerun/preds.json"
if os.path.exists(rerun):
    preds.update(json.load(open(rerun)))
with open(f"{out}/preds.mini.jsonl", "w") as f:
    for p in preds.values():
        f.write(json.dumps(p) + "\n")
print(f"{len(preds)} predictions, {sum(not p['model_patch'] for p in preds.values())} empty -> {out}/preds.mini.jsonl")
PY
