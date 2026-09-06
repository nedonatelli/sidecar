import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Nothing runs alongside a live eval sweep.
//
// A unit run started DURING a sweep competes with it for the local model: an
// arm that had been scoring 17/20 came back 6/16 with 13 timeouts, and nothing
// in the results said why. It read as a capability collapse rather than
// contention, so the sweep had to be discarded and re-run.
//
// The rule is deliberately asymmetric. Concurrent UNIT runs are fine and are
// relied upon — the pre-commit hook runs two at once on purpose. Only the eval
// sweep needs exclusivity, because only it is measuring something a competing
// process can silently corrupt.
// ---------------------------------------------------------------------------

const LOCK_DIR = process.env.SIDECAR_VITEST_LOCK_DIR ?? path.join(process.cwd(), '.sidecar', 'logs', 'vitest-locks');

interface LockHolder {
  pid: number;
  kind: 'eval' | 'unit';
  startedAt: string;
  command: string;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ownFile = (): string => path.join(LOCK_DIR, `${process.pid}.json`);

/** Live holders other than this process; dead and malformed entries are swept. */
const otherHolders = (): LockHolder[] => {
  const held: LockHolder[] = [];
  for (const name of fs.readdirSync(LOCK_DIR)) {
    const file = path.join(LOCK_DIR, name);
    let holder: LockHolder | null = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8')) as LockHolder;
    } catch {
      // Unreadable or half-written: not evidence of a live run.
    }
    if (!holder || !isAlive(holder.pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (holder.pid !== process.pid) held.push(holder);
  }
  return held;
};

const describe = (h: LockHolder): string => {
  const ageMin = Math.round((Date.now() - Date.parse(h.startedAt)) / 60_000);
  return `  ${h.kind} pid ${h.pid}, started ${ageMin} min ago: ${h.command}`;
};

let acquired = false;

export async function setup(): Promise<void> {
  if (process.env.SIDECAR_ALLOW_CONCURRENT_VITEST === '1') return;

  const kind: LockHolder['kind'] = process.env.SIDECAR_VITEST_KIND === 'eval' ? 'eval' : 'unit';
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.writeFileSync(
    ownFile(),
    JSON.stringify(
      { pid: process.pid, kind, startedAt: new Date().toISOString(), command: process.argv.slice(1).join(' ') },
      null,
      2,
    ),
  );
  acquired = true;

  // Registered first, then checked: two sweeps starting together both see each
  // other and both refuse, which is the safe direction to fail.
  const others = otherHolders();
  const blocking = kind === 'eval' ? others : others.filter((h) => h.kind === 'eval');
  if (blocking.length === 0) return;

  await teardown();
  throw new Error(
    (kind === 'eval'
      ? `Refusing to start an eval sweep: another vitest run is live.\n`
      : `Refusing to start: an eval sweep is live.\n`) +
      blocking.map(describe).join('\n') +
      `\n\nA competing run contends for the local model and silently corrupts the\n` +
      `sweep's arm — this has already cost one 20-trial sweep, which came back as\n` +
      `6/16 with 13 timeouts and looked like a model failure.\n\n` +
      `Wait for it to finish, or override with SIDECAR_ALLOW_CONCURRENT_VITEST=1.`,
  );
}

export async function teardown(): Promise<void> {
  if (!acquired) return;
  fs.rmSync(ownFile(), { force: true });
  acquired = false;
}
