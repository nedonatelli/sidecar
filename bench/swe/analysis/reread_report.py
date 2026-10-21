"""Attribute every re-read of a file an agent already read (#262).

    python3 -I bench/swe/analysis/reread_report.py --sidecar <trajectory dir> --claude-code <stream-json dir>

A re-read is any read of a path the run has read before. Each one is put in the
first class that fits, in this order:

  after-edit      the path was edited since the agent last read it: re-reading
                  to see the result of its own change
  after-compaction  the conversation was compacted since the last read of that
                  path, so the earlier content may no longer be in context
                  (SideCar only: messageCount dropped between iterations)
  new-window      a line range the run has not read in this file before
  repeat-window   a range the run already read, with neither of the above:
                  the content should still be in context

`repeat-window` is the waste this report exists to size. `new-window` can be
legitimate paging through a large file, but its count against the other agent
shows whether one agent pages in smaller steps.
"""
import argparse
import collections
import glob
import json
import os
import statistics

SIDECAR_EDIT = {'edit_file', 'write_file'}
CC_EDIT = {'Edit', 'Write', 'MultiEdit'}


def sidecar_reads(path):
    """Yield ('read', file, window) and ('edit', file) and ('compact',) in order."""
    last_count = None
    for line in open(path, encoding='utf-8', errors='replace'):
        e = json.loads(line)
        if e['type'] == 'iteration':
            count = e.get('messageCount')
            if last_count is not None and count is not None and count < last_count:
                yield ('compact',)
            last_count = count
        elif e['type'] == 'tool_call':
            inp = e.get('input') or {}
            p = os.path.normpath(inp.get('path') or '')
            if e['name'] == 'read_file':
                yield ('read', p, (inp.get('start_line'), inp.get('end_line')))
            elif e['name'] in SIDECAR_EDIT:
                yield ('edit', p)


def claude_code_reads(path):
    cwd = None
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get('type') == 'system' and ev.get('subtype') == 'init':
            cwd = ev.get('cwd')
        if ev.get('type') == 'system' and ev.get('subtype') == 'compact_boundary':
            yield ('compact',)
        if ev.get('type') != 'assistant':
            continue
        for c in ev['message'].get('content', []):
            if c.get('type') != 'tool_use':
                continue
            inp = c.get('input', {})
            p = inp.get('file_path') or ''
            if cwd and p.startswith(cwd):
                p = os.path.relpath(p, cwd)
            p = os.path.normpath(p)
            if c['name'] == 'Read':
                # Compared, never computed on: a few calls pass a list as offset.
                yield ('read', p, (repr(inp.get('offset')), repr(inp.get('limit'))))
            elif c['name'] in CC_EDIT:
                yield ('edit', p)


def classify(events):
    counts = collections.Counter()
    seen_windows = collections.defaultdict(set)
    dirty = set()          # edited since last read
    stale = set()          # compaction since last read
    read_paths = set()
    for ev in events:
        if ev[0] == 'compact':
            stale |= read_paths
        elif ev[0] == 'edit':
            dirty.add(ev[1])
        else:
            _, p, window = ev
            counts['reads'] += 1
            if p in read_paths:
                if p in dirty:
                    counts['after-edit'] += 1
                elif p in stale:
                    counts['after-compaction'] += 1
                elif window not in seen_windows[p]:
                    counts['new-window'] += 1
                else:
                    counts['repeat-window'] += 1
            read_paths.add(p)
            seen_windows[p].add(window)
            dirty.discard(p)
            stale.discard(p)
    counts['re-reads'] = sum(counts[k] for k in ('after-edit', 'after-compaction', 'new-window', 'repeat-window'))
    return counts


CLASSES = ['reads', 're-reads', 'after-edit', 'after-compaction', 'new-window', 'repeat-window']


def report(label, per_run):
    n = len(per_run)
    totals = collections.Counter()
    for c in per_run.values():
        totals.update(c)
    row = [f'{totals[k] / n:.1f}' for k in CLASSES]
    share = totals['re-reads'] or 1
    shares = [f"{100 * totals[k] / share:.0f}%" for k in CLASSES[2:]]
    return f'| {label} | {n} | ' + ' | '.join(row) + ' |', f'| {label} | ' + ' | '.join(shares) + ' |'


def top_repeats(per_run, k=5):
    ranked = sorted(per_run.items(), key=lambda kv: -kv[1]['repeat-window'])[:k]
    return ', '.join(f'{iid} ({c["repeat-window"]})' for iid, c in ranked)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--sidecar', action='append', default=[], metavar='DIR')
    ap.add_argument('--claude-code', action='append', default=[], metavar='DIR')
    args = ap.parse_args()

    runs = []
    for d in args.sidecar:
        per = {os.path.basename(f).split('.')[0]: classify(sidecar_reads(f)) for f in glob.glob(os.path.join(d, '*.trial0.jsonl'))}
        runs.append((f'SideCar ({os.path.basename(os.path.normpath(d))})', per))
    for d in args.claude_code:
        per = {os.path.basename(f).split('.')[0]: classify(claude_code_reads(f)) for f in glob.glob(os.path.join(d, '*.stream.jsonl'))}
        runs.append(('Claude Code', per))

    print('## Reads per task (mean)\n')
    print('| Agent | runs | ' + ' | '.join(CLASSES) + ' |')
    print('|---|---|' + '---|' * len(CLASSES))
    shares = []
    for label, per in runs:
        line, share = report(label, per)
        print(line)
        shares.append(share)
    print('\n## Share of re-reads by class\n')
    print('| Agent | ' + ' | '.join(CLASSES[2:]) + ' |')
    print('|---|' + '---|' * (len(CLASSES) - 2))
    print('\n'.join(shares))
    print('\n## Most repeat-window re-reads\n')
    for label, per in runs:
        print(f'- {label}: {top_repeats(per)}')


if __name__ == '__main__':
    main()
