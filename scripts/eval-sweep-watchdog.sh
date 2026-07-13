#!/bin/zsh
# Watchdog for long unattended eval sweeps: kill a vitest eval run whose CPU
# time stops advancing. Observed once during the v0.119 guard-probe sweep: a
# guardProbe vitest sat for an hour with 0.23s cumulative CPU, no output, and
# nothing loaded in Ollama, despite a 180s per-test timeout — the sweep only
# recovered when the process was killed (the sweep loop then continued).
# Never reproduced; this exists so a recurrence can't wedge an overnight run.
#
# Log-size checks don't work — vitest buffers output until the run completes —
# so cumulative CPU is the stall signal. Samples every 2 min; 5 consecutive
# no-progress samples (10 min) => kill. Run alongside a sweep script matching
# pgrep -f "guardprobe-sweep.sh"; adjust the pgrep patterns for other sweeps.

cpu_seconds() { # pid -> cumulative CPU in seconds
  local t=$(ps -o cputime= -p "$1" 2>/dev/null | tr -d ' ')
  [[ -z "$t" ]] && { echo ""; return; }
  # formats: MM:SS.ss or HH:MM:SS
  local IFS=':' parts=(${=t//:/ })
  parts=(${(s.:.)t})
  if (( ${#parts} == 3 )); then
    echo $(( parts[1]*3600 + parts[2]*60 + ${parts[3]%%.*} ))
  else
    echo $(( parts[1]*60 + ${parts[2]%%.*} ))
  fi
}

prev_pid=""
prev_cpu=0
stalls=0
for i in {1..150}; do  # 150 x 2min = 5h max
  sleep 120
  # Stop when the sweep script itself is gone.
  if ! pgrep -f "guardprobe-sweep.sh" >/dev/null 2>&1; then
    echo "watchdog: sweep script exited; stopping"
    break
  fi
  pid=$(pgrep -f "vitest run.*guardProbe" | head -1)
  if [[ -z "$pid" ]]; then
    prev_pid=""; stalls=0
    continue
  fi
  cpu=$(cpu_seconds "$pid")
  [[ -z "$cpu" ]] && continue
  if [[ "$pid" == "$prev_pid" ]] && (( cpu - prev_cpu < 2 )); then
    stalls=$((stalls + 1))
    echo "watchdog: pid=$pid cpu=${cpu}s no-progress sample $stalls/5"
    if (( stalls >= 5 )); then
      echo "watchdog: KILLING hung vitest pid=$pid (cpu frozen at ${cpu}s for 10min)"
      kill "$pid" 2>/dev/null
      stalls=0; prev_pid=""
    fi
  else
    [[ "$pid" != "$prev_pid" ]] && echo "watchdog: tracking new run pid=$pid"
    stalls=0
  fi
  prev_pid="$pid"; prev_cpu="$cpu"
done
echo "watchdog: done"
