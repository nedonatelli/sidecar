// ---------------------------------------------------------------------------
// Host-suspend detection for benchmark runs (#259).
//
// When the machine sleeps mid-task (lid closed, maintenance sleep), the wall
// clock keeps counting and the monotonic clock does not. On macOS the
// monotonic clock behind performance.now() is mach_absolute_time, which stops
// during sleep; on Linux it is CLOCK_MONOTONIC, which excludes suspend. The
// task's requests then look like 15-minute hangs, and the run was recorded as
// a model failure: on the 2026-10-20 Haiku canary, 7 consecutive tasks became
// EMPTY or timeouts, and all 7 produced patches (3 resolved) when rerun awake.
//
// So: note both clocks when a task starts; when it ends, wall time that ran
// ahead of monotonic time is time the host spent suspended. No timers needed.
//
// Windows: whether the monotonic clock stops during sleep there is not
// verified, so a suspend may go undetected on Windows (never falsely flagged:
// without drift nothing is reported).
// ---------------------------------------------------------------------------

export interface Clocks {
  wallMs(): number;
  monoMs(): number;
}

export const realClocks: Clocks = { wallMs: () => Date.now(), monoMs: () => performance.now() };

/** Drift below this is clock adjustment noise (NTP slews), not a suspend. */
export const SUSPEND_THRESHOLD_MS = 30_000;

/** Start watching; `suspendedMs()` is the time suspended since, or 0 below the threshold. */
export function startSuspendWatch(clocks: Clocks = realClocks): { suspendedMs(): number } {
  const wall0 = clocks.wallMs();
  const mono0 = clocks.monoMs();
  return {
    suspendedMs(): number {
      const drift = clocks.wallMs() - wall0 - (clocks.monoMs() - mono0);
      return drift > SUSPEND_THRESHOLD_MS ? Math.round(drift) : 0;
    },
  };
}

/** The failure reason for a suspended task; classified as infra (failureClassification). */
export function suspendReason(suspendedMs: number): string {
  const s = Math.round(suspendedMs / 1000);
  return `host suspended for ${s}s during the task (wall clock ran ${s}s ahead of the monotonic clock)`;
}
