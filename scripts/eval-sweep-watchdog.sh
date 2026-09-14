#!/usr/bin/env bash
# Watchdog for long unattended eval sweeps: kill a vitest eval run whose CPU
# time stops advancing. Observed once during the v0.119 guard-probe sweep: a
# guardProbe vitest sat for an hour with 0.23s cumulative CPU, no output, and
# nothing loaded in Ollama, despite a 180s per-test timeout — the sweep only
# recovered when the process was killed (the sweep loop then continued).
# Never reproduced; this exists so a recurrence can't wedge an overnight run.
#
# Log-size checks don't work — vitest buffers output until the run completes —
# so cumulative CPU is the stall signal. Samples every 2 min; 5 consecutive
# no-progress samples (10 min) => kill.
#
#   ./scripts/eval-sweep-watchdog.sh [sweep-script-name] [vitest-pattern]
#     default: guardprobe-sweep.sh   "vitest run.*guardProbe"
#
# Portability: bash 3.2+ (macOS's /bin/bash) and `ps -o cputime=` / `pgrep -f`,
# which macOS and Linux both provide. Not for Windows: Git Bash's `ps` has no
# cputime column; on Windows run the sweep and this watchdog under WSL.
set -u

SWEEP_SCRIPT="${1:-guardprobe-sweep.sh}"
VITEST_PATTERN="${2:-vitest run.*guardProbe}"

cpu_seconds() { # pid -> cumulative CPU in whole seconds ("" if the pid is gone)
  local t
  t=$(ps -o cputime= -p "$1" 2>/dev/null | tr -d ' ')
  [ -z "$t" ] && { echo ""; return; }
  # ps formats: MM:SS.ss (macOS), MM:SS or HH:MM:SS (Linux; days as D-HH:MM:SS).
  t=${t%%.*}                      # drop fractional seconds
  local days=0
  case "$t" in *-*) days=${t%%-*}; t=${t#*-} ;; esac
  local h=0 m=0 s=0
  IFS=':' read -r a b c <<EOF
$t
EOF
  if [ -n "${c:-}" ]; then h=$a; m=$b; s=$c; else m=$a; s=$b; fi
  # 10# forces decimal: "08" would otherwise be read as an invalid octal literal.
  echo $(( days*86400 + 10#$h*3600 + 10#$m*60 + 10#$s ))
}

prev_pid=""
prev_cpu=0
stalls=0
i=0
while [ $i -lt 150 ]; do  # 150 x 2min = 5h max
  i=$((i + 1))
  sleep 120
  # Stop when the sweep script itself is gone.
  if ! pgrep -f "$SWEEP_SCRIPT" >/dev/null 2>&1; then
    echo "watchdog: sweep script exited; stopping"
    break
  fi
  pid=$(pgrep -f "$VITEST_PATTERN" | head -1)
  if [ -z "$pid" ]; then
    prev_pid=""; stalls=0
    continue
  fi
  cpu=$(cpu_seconds "$pid")
  [ -z "$cpu" ] && continue
  if [ "$pid" = "$prev_pid" ] && [ $((cpu - prev_cpu)) -lt 2 ]; then
    stalls=$((stalls + 1))
    echo "watchdog: pid=$pid cpu=${cpu}s no-progress sample $stalls/5"
    if [ $stalls -ge 5 ]; then
      echo "watchdog: KILLING hung vitest pid=$pid (cpu frozen at ${cpu}s for 10min)"
      kill "$pid" 2>/dev/null
      stalls=0; prev_pid=""
    fi
  else
    [ "$pid" != "$prev_pid" ] && echo "watchdog: tracking new run pid=$pid"
    stalls=0
  fi
  prev_pid="$pid"; prev_cpu="$cpu"
done
echo "watchdog: done"
