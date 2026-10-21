"""Compare agents on the same SWE task set: resolve rates, paired significance,
per-repo breakdown, and what each agent actually did (turns, tool calls,
re-reads, budget refusals).

    python3 -I bench/swe/analysis/compare_agents.py --slice bench/swe/data/canary.jsonl \\
        --run "SideCar on:sidecar:<resolved.json>:<trajectory dir>" \\
        --run "Claude Code:claude-code:<resolved.json>:<stream-json dir>" \\
        --run "mini:mini:<resolved.json>:<output dir>" > comparison.md

Each --run is LABEL:KIND:RESOLVED:TRAJ. KIND is sidecar (swe.eval.ts
*.trial0.jsonl; sidecar@ARM picks one arm out of a two-arm directory),
claude-code (bench/swe/baselines/claude_code.py *.stream.jsonl) or mini
(mini-SWE-agent */*.traj.json). RESOLVED and TRAJ may
each list several paths joined by `+`: a later report overrides an earlier one
for every instance it submitted, so a rerun of a few tasks merges over the
original run.

Why this exists: the 2026-10-20 Haiku comparison was answered by a dozen
one-off snippets, each re-deriving "which tool call is a test run" in its own
regex. One script keeps the definitions in one place.
"""
import argparse
import collections
import glob
import json
import os
import re
import statistics
from math import comb

TEST = re.compile(r'pytest|runtests\.py|unittest|bin/test|\btox\b|python -m test')
SEARCH = re.compile(r'^(cd \S+ && )?(grep|rg|find|ls|tree)\b')
BUDGET_REFUSAL = 'times this session (budget'


def mcnemar(a, b):
    """Two-sided exact McNemar p on the discordant pairs."""
    x, y = len(a - b), len(b - a)
    n = x + y
    if n == 0:
        return x, y, 1.0
    return x, y, min(1.0, 2 * sum(comb(n, i) for i in range(min(x, y) + 1)) / 2**n)


def load_resolved(spec):
    resolved = set()
    for path in spec.split('+'):
        r = json.load(open(path))
        resolved -= set(r['submitted_ids'])
        resolved |= set(r['resolved_ids'])
    return resolved


def sidecar_calls(path):
    calls, refusals, iterations = [], 0, 0
    for line in open(path, encoding='utf-8', errors='replace'):
        e = json.loads(line)
        if e['type'] == 'iteration':
            iterations += 1
        elif e['type'] == 'tool_call':
            inp = e.get('input') or {}
            calls.append((e['name'], inp.get('command', ''), inp.get('path')))
        elif e['type'] == 'tool_result' and BUDGET_REFUSAL in str(e.get('result', '')):
            refusals += 1
    return calls, iterations, refusals


def claude_code_calls(path):
    """Turns are Claude Code's own `num_turns` when the run finished; counting
    distinct API responses instead differs on a few runs."""
    calls, responses, num_turns = [], set(), None
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get('type') == 'result':
            num_turns = ev.get('num_turns')
        if ev.get('type') != 'assistant':
            continue
        responses.add(ev['message'].get('id'))
        for c in ev['message'].get('content', []):
            if c.get('type') == 'tool_use':
                inp = c.get('input', {})
                calls.append((c['name'], inp.get('command', ''), inp.get('file_path')))
    return calls, num_turns if num_turns is not None else len(responses), 0


def mini_calls(path):
    t = json.load(open(path))
    calls = []
    for m in t.get('messages', []):
        for tc in m.get('tool_calls') or []:
            try:
                cmd = json.loads(tc['function']['arguments']).get('command', '')
            except (KeyError, json.JSONDecodeError):
                cmd = ''
            calls.append(('bash', cmd, None))
    return calls, t['info']['model_stats']['api_calls'], 0


LOADERS = {
    'sidecar': ('*.trial0.jsonl', sidecar_calls),
    'claude-code': ('*.stream.jsonl', claude_code_calls),
    'mini': ('*/*.traj.json', mini_calls),
}
SHELL = {'run_command', 'Bash', 'bash'}
READ = {'read_file', 'Read'}
EDIT = {'edit_file', 'write_file', 'Edit', 'Write'}


def load_telemetry(kind, spec):
    kind, _, arm = kind.partition('@')
    pattern, loader = LOADERS[kind]
    if arm:
        pattern = f'*.{arm}.*trial0.jsonl'
    per = {}
    for d in spec.split('+'):
        for path in glob.glob(os.path.join(d, pattern)):
            iid = os.path.basename(path).split('.')[0]
            calls, turns, refusals = loader(path)
            shell = [c for c in calls if c[0] in SHELL]
            reads = collections.Counter(c[2] for c in calls if c[0] in READ)
            edits = [i for i, c in enumerate(calls) if c[0] in EDIT]
            per[iid] = {
                'turns': turns,
                'calls': len(calls),
                'shell': len(shell),
                'tests': sum(bool(TEST.search(c[1])) for c in shell),
                'searches': sum(bool(SEARCH.match(c[1].strip())) for c in shell),
                'reads': sum(reads.values()),
                're_reads': sum(v - 1 for v in reads.values() if v > 1),
                'first_edit': edits[0] if edits else None,
                'refusals': refusals,
            }
    return per


def mean(values):
    values = [v for v in values if v is not None]
    return f'{statistics.mean(values):.1f}' if values else '—'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--slice', required=True)
    ap.add_argument('--run', action='append', required=True, metavar='LABEL:KIND:RESOLVED:TRAJ')
    args = ap.parse_args()

    tasks = sorted(json.loads(l)['instance_id'] for l in open(args.slice) if l.strip())
    runs = []
    for spec in args.run:
        label, kind, resolved, traj = spec.split(':', 3)
        runs.append((label, load_resolved(resolved) & set(tasks), load_telemetry(kind, traj)))

    print(f'## Resolve rates ({len(tasks)} tasks)\n')
    print('| Agent | Resolved |\n|---|---|')
    for label, res, _ in runs:
        print(f'| {label} | {len(res)}/{len(tasks)} |')

    print('\n## Paired comparison (McNemar, two-sided exact)\n')
    print('| A | B | only A | only B | p |\n|---|---|---|---|---|')
    for i, (la, ra, _) in enumerate(runs):
        for lb, rb, _ in runs[i + 1:]:
            x, y, p = mcnemar(ra, rb)
            print(f'| {la} | {lb} | {x} | {y} | {p:.3f} |')

    print('\n## Per repo\n')
    print('| Repo | n | ' + ' | '.join(label for label, _, _ in runs) + ' |')
    print('|---|---|' + '---|' * len(runs))
    by_repo = collections.defaultdict(list)
    for t in tasks:
        by_repo[t.split('__')[1].rsplit('-', 1)[0]].append(t)
    for repo, ts in sorted(by_repo.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        print(f'| {repo} | {len(ts)} | ' + ' | '.join(str(sum(t in res for t in ts)) for _, res, _ in runs) + ' |')

    print('\n## What the agents did (mean per task)\n')
    cols = [('turns', 'Model turns'), ('calls', 'Tool calls'), ('shell', 'Shell commands'),
            ('tests', 'Test runs'), ('searches', 'Searches (shell)'), ('reads', 'File reads'),
            ('re_reads', 'Re-reads of a read file'), ('first_edit', 'First edit at call #'),
            ('refusals', 'Budget refusals')]
    print('| Metric | ' + ' | '.join(label for label, _, _ in runs) + ' |')
    print('|---|' + '---|' * len(runs))
    for key, name in cols:
        print(f'| {name} | ' + ' | '.join(mean(v[key] for v in tel.values()) for _, _, tel in runs) + ' |')
    print('| Runs with telemetry | ' + ' | '.join(str(len(tel)) for _, _, tel in runs) + ' |')

    print('\n## Turn distribution\n')
    print('| Agent | median | p90 | max | >50 | >100 |\n|---|---|---|---|---|---|')
    for label, _, tel in runs:
        t = sorted(v['turns'] for v in tel.values())
        if t:
            print(f'| {label} | {statistics.median(t)} | {t[int(0.9 * (len(t) - 1))]} | {t[-1]} | '
                  f'{sum(x > 50 for x in t)} | {sum(x > 100 for x in t)} |')


if __name__ == '__main__':
    main()
