"""Summarise the agent's structured decisions across a SWE matrix.

    python bench/swe/analysis/decisions_report.py <ROOT> [--by-task]

<ROOT> is a matrix directory: <ROOT>/<arm>/seed<N>/*.trial0.jsonl (or a single
cell with the trajectories directly inside it). Each `decision` event carries
the iteration it happened in and the record from src/agent/decisions.ts.

Why this exists: decisions reached analysis only as per-run COUNTS in the meta
row (`decisionCounts`), so every question about WHICH edit wrote nothing, or
when the agent last verified, meant another one-off script re-deriving it from
tool-result text -- the duplication the structured records were built to end.

Runs recorded before trajectories carried decision events have none; they are
counted and reported as "no decision events", never silently as zero.
"""
import collections
import glob
import json
import os
import statistics
import sys


def load_runs(root):
    """Yield (arm, seed, instance, events) for every trajectory under root."""
    paths = glob.glob(os.path.join(root, '*', 'seed*', '*.trial0.jsonl')) or glob.glob(os.path.join(root, '*.trial0.jsonl'))
    for p in sorted(paths):
        rel = os.path.relpath(p, root).split(os.sep)
        arm = rel[0] if len(rel) == 3 else os.path.basename(root)
        name = os.path.basename(p)
        seed = name.split('.seed')[1].split('.')[0] if '.seed' in name else '?'
        events = []
        for line in open(p, encoding='utf-8', errors='replace'):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        yield arm, seed, name.split('.')[0], events


def run_stats(events):
    """Per-run decision facts. None when the run predates decision events."""
    ds = [e for e in events if e.get('type') == 'decision']
    if not ds:
        return None
    s = {'counts': collections.Counter(), 'edits': 0, 'no_change': 0, 'unverified_rewrite': 0,
         'max_writes_since_verify': 0, 'first_applied_iter': None, 'first_verify_iter': None,
         'verify_recognized': 0, 'verify_unrecognized': 0}
    for e in ds:
        d, it = e.get('decision', {}), e.get('iteration')
        kind = e.get('kind') or d.get('kind')
        s['counts'][kind] += 1
        if kind == 'edit_outcome':
            s['edits'] += 1
            if d.get('applied'):
                s['counts'][f"edit_outcome.parses.{d.get('parses')}"] += 1
                w = d.get('writesSinceVerify') or 0
                s['max_writes_since_verify'] = max(s['max_writes_since_verify'], w)
                if w > 1:
                    s['unverified_rewrite'] += 1
                if s['first_applied_iter'] is None:
                    s['first_applied_iter'] = it
            else:
                s['no_change'] += 1
        elif kind == 'verification_run':
            s['verify_recognized' if d.get('recognized') else 'verify_unrecognized'] += 1
            if d.get('recognized') and s['first_verify_iter'] is None:
                s['first_verify_iter'] = it
        elif 'action' in d:
            s['counts'][f"{kind}.{d['action']}"] += 1
    return s


def mean(xs):
    xs = [x for x in xs if x is not None]
    return f'{statistics.mean(xs):.1f}' if xs else '-'


def report(root, by_task=False):
    by_arm = collections.defaultdict(list)
    for arm, seed, inst, events in load_runs(root):
        by_arm[arm].append((seed, inst, run_stats(events)))
    if not by_arm:
        print(f'no trajectories under {root}')
        return
    for arm, runs in sorted(by_arm.items()):
        have = [(sd, i, s) for sd, i, s in runs if s is not None]
        print(f'== {arm}: {len(runs)} runs, {len(have)} with decision events'
              + (f' ({len(runs) - len(have)} recorded before decision events existed)' if len(have) < len(runs) else ''))
        if not have:
            continue
        st = [s for _, _, s in have]
        edits = sum(s['edits'] for s in st)
        noop = sum(s['no_change'] for s in st)
        print(f'  edit_file outcomes   {edits} total, {noop} wrote nothing ({100 * noop / max(1, edits):.0f}%)')
        print(f'  runs with >=1 no-op edit           {sum(1 for s in st if s["no_change"])}/{len(st)}')
        print(f'  runs with an unverified rewrite    {sum(1 for s in st if s["unverified_rewrite"])}/{len(st)}'
              f'  (a file written again with nothing run against it since)')
        print(f'  max writes-since-verify per run    mean {mean([s["max_writes_since_verify"] for s in st])}')
        rec = sum(s['verify_recognized'] for s in st)
        unrec = sum(s['verify_unrecognized'] for s in st)
        print(f'  shell commands as verification     {rec} recognised, {unrec} not')
        print(f'  first applied edit at iteration    mean {mean([s["first_applied_iter"] for s in st])}')
        print(f'  first recognised test run at iter  mean {mean([s["first_verify_iter"] for s in st])}'
              f'  ({sum(1 for s in st if s["first_verify_iter"] is None)} runs never ran one)')
        total = collections.Counter()
        for s in st:
            total.update(s['counts'])
        print('  all decision counts: ' + ', '.join(f'{k}={v}' for k, v in sorted(total.items())))
        if by_task:
            for sd, inst, s in sorted(have, key=lambda r: (r[1], r[0])):
                print(f'    {inst:40s} s{sd}  edits={s["edits"]:2d} noop={s["no_change"]:2d} '
                      f'unverified-rewrites={s["unverified_rewrite"]:2d} first-edit@{s["first_applied_iter"]} '
                      f'first-test@{s["first_verify_iter"]}')
        print()


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        sys.exit(__doc__)
    report(args[0], by_task='--by-task' in sys.argv)
