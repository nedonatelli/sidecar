/**
 * Today's date for the system prompt's Session block.
 *
 * Without it the model has no idea what day it is: "today", "latest" and
 * "recent" silently mean its training cutoff, so "what is the latest version
 * of X?" got a confident, stale answer.
 *
 * - Source: this computer's clock -- the only source that also works offline.
 *   A wrong system clock is wrong here too.
 * - The user's LOCAL date and timezone: at 9 PM Eastern, UTC already says
 *   tomorrow.
 * - The date only, never the time: a time would change the prompt every minute,
 *   so no prompt-cache hits and no two eval runs alike. It sits in the Session
 *   block, which is rebuilt every message and lives in the uncached suffix, so
 *   a new day costs one cache refresh.
 * - SIDECAR_PROMPT_DATE=YYYY-MM-DD pins it (UTC) for evals, like
 *   SIDECAR_AGENT_SEED, so a run that crosses midnight stays reproducible.
 */
export function promptDateLine(
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const pinned = process.env.SIDECAR_PROMPT_DATE;
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned) && !Number.isNaN(Date.parse(`${pinned}T12:00:00Z`))) {
    now = new Date(`${pinned}T12:00:00Z`);
    timeZone = 'UTC';
  }
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const long = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  return (
    `- Today's date: ${long} (${iso}), timezone ${zone}. Use it for "today", "latest" and "recent"; ` +
    `your training data may be older than this date.`
  );
}
