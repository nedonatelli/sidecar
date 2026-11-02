/**
 * Pure helpers for the installed-VSIX smoke test (#396): read a SideCar log
 * into startup timings, check them against budgets, and summarize an
 * extension-host CPU profile by self time. No I/O, so each is unit-tested.
 */

const TS = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \[(\w+)\] (.*)$/;

/** Milliseconds since the epoch for a log timestamp (local time, as the log writes it). */
function at(stamp) {
  return new Date(stamp.replace(' ', 'T')).getTime();
}

/** The log lines the smoke test reads, each with its time. */
const MARKS = {
  activating: /SideCar extension activating/,
  workspaceIndexed: /\[SideCar\] Workspace indexed: (\d+) files/,
  treeSitter: /\[SideCar\] Tree-sitter loaded/,
  symbolGraph: /\[SideCar\] Symbol graph built: (\d+) symbols/,
  docIndex: /\[SideCar\] Documentation index built: (\d+) entries in (\d+)ms/,
  pkiReplay: /\[PKI\] replay (?:complete|queued nothing)/,
  indexingReady: /\[SideCar\] Indexing status: ready/,
  modelsListed: /\[SideCar\] Models listed: (\d+) in (\d+)ms/,
  stallSummary:
    /\[SideCar\] activation: (?:no event-loop stalls|(\d+) event-loop stall\(s\) over \d+ ms, longest (\d+) ms, (\d+) ms blocked in total)/,
};

/** Warnings that mean the packaged build is missing or failing to load something. */
const LOAD_FAILURE = /Cannot find module|failed to load|Failed to load|ERR_DLOPEN|is not a valid Win32 application/;

/**
 * Parse a SideCar output-channel log. Returns the first time of each mark,
 * the numbers they carry, every stall the watcher logged, and load failures.
 */
export function parseSidecarLog(text) {
  const marks = {};
  const stalls = [];
  const loadFailures = [];
  const facts = {};
  for (const line of text.split(/\r?\n/)) {
    const m = TS.exec(line);
    if (!m) continue;
    const [, stamp, level, msg] = m;
    const t = at(stamp);
    for (const [name, re] of Object.entries(MARKS)) {
      if (name in marks) continue;
      const hit = re.exec(msg);
      if (!hit) continue;
      marks[name] = t;
      if (name === 'workspaceIndexed') facts.files = Number(hit[1]);
      if (name === 'symbolGraph') facts.symbols = Number(hit[1]);
      if (name === 'docIndex') Object.assign(facts, { docEntries: Number(hit[1]), docIndexMs: Number(hit[2]) });
      if (name === 'modelsListed') Object.assign(facts, { models: Number(hit[1]), modelsMs: Number(hit[2]) });
      if (name === 'stallSummary') {
        Object.assign(facts, {
          stallCount: Number(hit[1] ?? 0),
          longestStallMs: Number(hit[2] ?? 0),
          stalledMs: Number(hit[3] ?? 0),
        });
      }
    }
    const stall = /activation: event loop blocked (\d+) ms/.exec(msg);
    if (stall) stalls.push({ t, ms: Number(stall[1]) });
    if ((level === 'warning' || level === 'error') && LOAD_FAILURE.test(msg)) loadFailures.push(msg.slice(0, 300));
  }
  return { marks, facts, stalls, loadFailures };
}

/** Elapsed ms between two marks, or null when either is missing. */
function span(marks, from, to) {
  return marks[from] !== undefined && marks[to] !== undefined ? marks[to] - marks[from] : null;
}

export const DEFAULT_BUDGETS = {
  /** Activation to the first "indexing ready". */
  readyMs: 120_000,
  /** Tree-sitter loaded to symbol graph built. */
  symbolGraphMs: 60_000,
  /** The documentation index's own reported build time. */
  docIndexMs: 60_000,
  /** Longest single event-loop stall. */
  longestStallMs: 5_000,
};

/**
 * Startup timings for one run, and every budget it broke. A missing mark is a
 * failure: a run that never reports "ready" has not passed by staying quiet.
 */
export function checkRun(parsed, budgets = DEFAULT_BUDGETS) {
  const { marks, facts, stalls, loadFailures } = parsed;
  // A stall still being logged when the run ends has no summary line yet.
  const longestStallMs = Math.max(facts.longestStallMs ?? 0, ...stalls.map((s) => s.ms), 0);
  const timings = {
    readyMs: span(marks, 'activating', 'indexingReady'),
    symbolGraphMs: span(marks, 'treeSitter', 'symbolGraph'),
    docIndexMs: facts.docIndexMs ?? null,
    longestStallMs,
    stallCount: Math.max(facts.stallCount ?? 0, stalls.length),
    modelsMs: facts.modelsMs ?? null,
  };
  const failures = [];
  if (marks.activating === undefined) failures.push('SideCar never logged activation');
  for (const key of ['readyMs', 'symbolGraphMs', 'docIndexMs']) {
    if (timings[key] === null) failures.push(`${key}: not reached`);
    else if (timings[key] > budgets[key]) failures.push(`${key}: ${timings[key]} ms > budget ${budgets[key]} ms`);
  }
  if (longestStallMs > budgets.longestStallMs) {
    failures.push(`longestStallMs: ${longestStallMs} ms > budget ${budgets.longestStallMs} ms`);
  }
  for (const f of loadFailures) failures.push(`load failure: ${f}`);
  return { timings, facts, failures };
}

/**
 * Self time per function in a V8 `.cpuprofile`, highest first. A function's
 * self time is the sampling time spent in it and not in a callee: where the
 * thread actually was.
 */
export function topSelfTime(profile, limit = 15) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const key = `${functionName || '(anonymous)'} ${shortUrl(url)}:${lineNumber + 1}`;
    // A sample's duration is the delta to the next one.
    const us = deltas[i + 1] ?? 0;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const totalUs = [...self.values()].reduce((a, b) => a + b, 0);
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fn, us]) => ({ fn, ms: Math.round(us / 1000), share: totalUs ? us / totalUs : 0 }));
}

/** Drop the install location so a profile summary names the file, not the machine. */
export function shortUrl(url) {
  if (!url) return '(native)';
  const m = /(?:extensions[\\/][^\\/]+[\\/]|resources[\\/]app[\\/])(.*)$/.exec(url.replace(/^file:\/\/\/?/, ''));
  return m ? m[1].replace(/\\/g, '/') : url.replace(/^.*[\\/]/, '');
}
