#!/usr/bin/env bash
# Re-record agent baselines, sequentially, with a live backend probe per model.
#
# The previous sweep lost three models to a wedged Ollama: the laptop lid closed,
# Ollama stopped serving, and each remaining model spent ~50 minutes discovering
# that one case at a time before its circuit breaker fired. The breaker works —
# it aborts rather than grinding — but it only acts AFTER three failed cases.
#
# So probe generation before each model and stop the whole sweep when the backend
# is dead. A reachable /api/tags is not evidence it can serve; only a completed
# generation is.
set -uo pipefail
cd "$(dirname "$0")/.."

MODELS=("$@")
[ ${#MODELS[@]} -eq 0 ] && { echo "usage: $0 <model> [model...]"; exit 2; }

STAMP=$(date +%Y%m%dT%H%M%S)
DIR=".sidecar/logs/sweeps/$STAMP"
mkdir -p "$DIR"
echo "sweep $STAMP -> $DIR"
echo "models: ${MODELS[*]}"

probe() {
  # Parsed with node, not python3: node is guaranteed in this repo, while
  # `python3` on a Windows Git Bash is the Microsoft Store stub (opens the
  # Store, prints nothing) -- which this probe would read as "backend dead".
  curl -s --max-time 120 http://localhost:11434/api/generate \
    -d "{\"model\":\"$1\",\"prompt\":\"Reply with the single word: ok\",\"stream\":false}" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(((JSON.parse(s).response||'').trim()).slice(0,20))}catch{}})" 2>/dev/null
}

for m in "${MODELS[@]}"; do
  echo "=== $(date '+%H:%M:%S') probing $m"
  got=$(probe "$m")
  if [ -z "$got" ]; then
    echo "=== $(date '+%H:%M:%S') ABORT: $m returned nothing to a probe — backend not serving."
    echo "    Remaining models NOT attempted: everything from $m onward."
    echo "    Restart Ollama, then re-run this script with the remaining models."
    exit 1
  fi
  echo "    probe ok ('$got')"

  safe=${m//[^a-zA-Z0-9._-]/_}
  log="$DIR/$safe.log"
  echo "=== $(date '+%H:%M:%S') START $m -> $log"
  SIDECAR_EVAL_BACKEND=ollama SIDECAR_EVAL_MODEL="$m" \
    npm run eval:agent:baseline:record >"$log" 2>&1
  code=$?
  pass=$(grep -c ': pass (' "$log"); fail=$(grep -c ': FAIL (' "$log")
  echo "=== $(date '+%H:%M:%S') DONE  $m exit=$code  pass=$pass fail=$fail"
  if grep -q "circuit breaker" "$log"; then
    echo "    circuit breaker fired — backend died mid-model. Stopping the sweep."
    echo "    Remaining models NOT attempted."
    exit 1
  fi
done
echo "=== $(date '+%H:%M:%S') SWEEP COMPLETE"
