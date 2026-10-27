"""SWE-bench scorer preflight: prove each instance image can score a patch at all,
before any model patch is scored against it.

Per instance, recorded with the docker image ID it ran against:
  1. env      the harness's own activation lines run in the image
              (source /opt/miniconda3/bin/activate; conda activate testbed; cd /testbed)
  2. import   the project imports after activation (python -c "import <package>")
  3. patch    the gold TEST patch applies to the image's checkout (git apply --check)
  4. base     a harness run whose patch changes no code (adds one unrelated file):
              at least one FAIL_TO_PASS test must FAIL. F2P tests that already pass, and
              PASS_TO_PASS tests that fail, are recorded as warnings (mislabeled tests)
  5. gold     a harness run with the gold patch: the instance must resolve
A model patch's score means nothing on an instance that fails one of these.

Runs in the WSL swebench venv (swebench 5.x):
  ~/swebench-venv/bin/python bench/swe/scorer_preflight.py run --instances ids.txt [--max-workers 4] [--reuse]
  ~/swebench-venv/bin/python bench/swe/scorer_preflight.py gate --predictions preds.jsonl
`run` writes/updates the cache (--cache-dir, else $SIDECAR_SWE_PREFLIGHT_DIR, else
~/.cache/sidecar/swe-preflight; one <dataset>.json per dataset). `gate` exits 1 unless
every instance in the predictions file has a passing preflight for the image ID it has
now; bench/swe/local/score_local.sh and cloud/run_campaign.sh call both before scoring.
"""
import argparse, datetime, json, os, subprocess, sys
from pathlib import Path

DATASET = 'SWE-bench/SWE-bench_Lite'
DEFAULT_DIR = Path(os.environ.get('SIDECAR_SWE_PREFLIGHT_DIR') or Path.home() / '.cache' / 'sidecar' / 'swe-preflight')
# repo -> module to import after activation
PACKAGES = {
    'django/django': 'django', 'sympy/sympy': 'sympy', 'scikit-learn/scikit-learn': 'sklearn',
    'matplotlib/matplotlib': 'matplotlib', 'astropy/astropy': 'astropy', 'mwaskom/seaborn': 'seaborn',
    'psf/requests': 'requests', 'pydata/xarray': 'xarray', 'pylint-dev/pylint': 'pylint',
    'sphinx-doc/sphinx': 'sphinx', 'pytest-dev/pytest': 'pytest',
}
ACTIVATE = 'source /opt/miniconda3/bin/activate && conda activate testbed && cd /testbed'
# A patch that applies everywhere and changes no code, so only the test patch acts.
NOOP_PATCH = (
    'diff --git a/sidecar_preflight.txt b/sidecar_preflight.txt\nnew file mode 100644\n'
    '--- /dev/null\n+++ b/sidecar_preflight.txt\n@@ -0,0 +1 @@\n+preflight\n'
)


def sh(cmd, inp=None, timeout=600):
    r = subprocess.run(cmd, input=inp, capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr)


def image_id(image):
    code, out = sh(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], timeout=60)
    return out.strip() if code == 0 else None


def in_image(image, script, inp=None, timeout=600):
    return sh(['docker', 'run', '--rm', '-i', image, 'bash', '-lc', script], inp=inp, timeout=timeout)


def cache_path(d, dataset):
    return Path(d) / f"{dataset.replace('/', '__')}.json"


def load_cache(p):
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}


def refuse_windows_native():
    """swebench run from Windows-native Python cannot score anything.

    Seen on the 2026-10-26 Nemotron scoring: Windows text mode wrote eval.sh with
    CRLF, so in the Linux container every line ended in `\\r` (`cd $'/testbed\\r'`,
    `source $'.../activate\\r'`), activation and the editable install failed, and the
    test patch did not apply -- for all 17 instances that produced output, including
    the 12 reported as "cleanly scored, unresolved". The other 2 crashed writing test
    output in cp1252. Score from WSL or Linux.
    """
    if os.name == 'nt':
        sys.exit('REFUSING: run the SWE-bench scorer from WSL or Linux, not Windows-native Python '
                 '(eval.sh is written with CRLF and every instance\'s setup fails). See scorer_preflight.py.')


def harness(preds, run_id, workdir, max_workers, dataset):
    """Run the harness from `workdir` so its logs land in workdir/logs/run_evaluation/<run_id>.
    UTF-8 mode: test output with characters outside the locale encoding crashed the writer."""
    cmd = [sys.executable, '-m', 'swebench.harness.run_evaluation', '--dataset_name', dataset,
           '--predictions_path', str(preds), '--max_workers', str(max_workers), '--run_id', run_id,
           '--report_dir', str(workdir)]
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
    r = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    (workdir / f'{run_id}.harness.log').write_text(r.stdout + r.stderr, encoding='utf-8')


# bash's xtrace of a command whose line ended in a carriage return: `+ cd $'/testbed\r'`
CRLF_SETUP = "$'/testbed\\r'"


def report_for(workdir, run_id, model, iid):
    """(report, error, crlf): the instance's report, or the log tail when there is none;
    crlf is True when the test output shows the CRLF-broken setup."""
    base = workdir / 'logs' / 'run_evaluation' / run_id / model / iid
    out = base / 'test_output.txt'
    crlf = out.exists() and CRLF_SETUP in out.read_text(encoding='utf-8', errors='replace')
    rep = base / 'report.json'
    if rep.exists():
        return json.loads(rep.read_text(encoding='utf-8')).get(iid, {}), None, crlf
    log = base / 'run_instance.log'
    tail = log.read_text(encoding='utf-8', errors='replace')[-600:] if log.exists() else 'no run_instance.log'
    return None, tail, crlf


def cmd_run(a):
    refuse_windows_native()
    import swebench.harness.run_evaluation as r
    ids = [l.strip() for l in Path(a.instances).read_text(encoding='utf-8').splitlines() if l.strip()]
    insts = {i['instance_id']: i for i in r.load_swebench_dataset(a.dataset, 'test', ids)}
    missing = sorted(set(ids) - set(insts))
    if missing:
        sys.exit(f'not in {a.dataset}: {missing}')
    cdir = Path(a.cache_dir); cdir.mkdir(parents=True, exist_ok=True)
    cpath = cache_path(cdir, a.dataset); cache = load_cache(cpath)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    work = cdir / f'run-{stamp}'; work.mkdir()

    todo, results = [], {}
    for iid in ids:
        spec = r.make_test_spec(insts[iid])
        img_id = image_id(spec.image)
        prev = cache.get(iid)
        if a.reuse and prev and prev.get('status') == 'OK' and prev.get('image_id') == img_id:
            results[iid] = prev; continue
        res = {'image': spec.image, 'image_id': img_id, 'checked_at': stamp, 'checks': {}}
        results[iid] = res
        if img_id is None:
            res['status'] = 'IMAGE_MISSING'; continue
        code, out = in_image(spec.image, f'{ACTIVATE} && python --version')
        res['checks']['env'] = {'ok': code == 0, 'out': out[-300:]}
        if code != 0:
            res['status'] = 'ENV_BROKEN'; continue
        pkg = PACKAGES.get(insts[iid]['repo'])
        code, out = in_image(spec.image, f'{ACTIVATE} && python -c "import {pkg}; print({pkg}.__file__)"')
        res['checks']['import'] = {'ok': code == 0, 'package': pkg, 'out': out[-300:]}
        if code != 0:
            res['status'] = 'IMPORT_FAILS'; continue
        code, out = in_image(spec.image, f'{ACTIVATE} && git apply --check -', inp=insts[iid]['test_patch'])
        res['checks']['test_patch'] = {'ok': code == 0, 'out': out[-300:]}
        if code != 0:
            res['status'] = 'TEST_PATCH_FAILS'; continue
        todo.append(iid)

    if todo:
        for kind, patch_of in (('base', lambda i: NOOP_PATCH), ('gold', lambda i: insts[i]['patch'])):
            preds = work / f'{kind}.jsonl'
            lines = [json.dumps({'instance_id': i, 'model_name_or_path': f'preflight-{kind}', 'model_patch': patch_of(i)})
                     for i in todo]
            preds.write_text(''.join(line + '\n' for line in lines), encoding='utf-8', newline='\n')
            harness(preds, f'preflight-{kind}-{stamp}', work, a.max_workers, a.dataset)
        for iid in todo:
            res = results[iid]
            base, base_err, base_crlf = report_for(work, f'preflight-base-{stamp}', 'preflight-base', iid)
            gold, gold_err, gold_crlf = report_for(work, f'preflight-gold-{stamp}', 'preflight-gold', iid)
            if base_crlf or gold_crlf:
                res['status'] = 'SCRIPT_CRLF'; res['checks']['base'] = {'ok': False, 'out': 'eval.sh ran with CRLF line endings'}; continue
            if base is None:
                res['status'] = 'BASE_RUN_ERROR'; res['checks']['base'] = {'ok': False, 'out': base_err}; continue
            ts = base.get('tests_status', {})
            f2p_pass = ts.get('FAIL_TO_PASS', {}).get('success', [])
            f2p_fail = ts.get('FAIL_TO_PASS', {}).get('failure', [])
            p2p_fail = ts.get('PASS_TO_PASS', {}).get('failure', [])
            res['checks']['base'] = {'ok': bool(f2p_fail), 'f2p_passing': f2p_pass, 'f2p_failing': f2p_fail,
                                     'p2p_failing': p2p_fail}
            if gold is None:
                res['status'] = 'GOLD_RUN_ERROR'; res['checks']['gold'] = {'ok': False, 'out': gold_err}; continue
            res['checks']['gold'] = {'ok': bool(gold.get('resolved')), 'tests_status': gold.get('tests_status', {})}
            # A resolve can be trusted when the unpatched code fails at least one F2P
            # test and gold resolves. Labels that are only partly right are warnings:
            # on the 2026-10-26 canary preflight, django-11099 and requests-1963 list F2P
            # tests that already pass unpatched, and sympy-13177 lists as P2P a test that
            # fails unpatched and passes with gold. They do not change resolve, but the
            # P2P one shows up in P2P-regress for any patch that does not fix it.
            res['warnings'] = ([f'F2P_PASS_AT_BASE {len(f2p_pass)}/{len(f2p_pass) + len(f2p_fail)}'] if f2p_pass else []) + \
                              ([f'P2P_FAILS_AT_BASE {p2p_fail}'] if p2p_fail else [])
            res['status'] = ('BASE_ALREADY_PASSES' if not f2p_fail
                             else 'GOLD_FAILS' if not gold.get('resolved') else 'OK')

    import swebench
    for iid, res in results.items():
        res['swebench'] = swebench.__version__
        cache[iid] = res
    cpath.write_text(json.dumps(cache, indent=1), encoding='utf-8')
    bad = {i: r_['status'] for i, r_ in results.items() if r_['status'] != 'OK'}
    print(f'{len(results) - len(bad)}/{len(results)} OK  (cache {cpath}, run dir {work})')
    for i, s in sorted(bad.items()):
        print(f'  {s:20s} {i}')
    for i, r_ in sorted(results.items()):
        for w in r_.get('warnings', []):
            print(f'  warning {i}: {w}')
    return 1 if bad else 0


def cmd_gate(a):
    refuse_windows_native()
    cache = load_cache(cache_path(a.cache_dir, a.dataset))
    import swebench.harness.run_evaluation as r
    preds = [json.loads(l) for l in Path(a.predictions).read_text(encoding='utf-8').splitlines() if l.strip()]
    ids = [p['instance_id'] for p in preds]
    insts = {i['instance_id']: i for i in r.load_swebench_dataset(a.dataset, 'test', ids)}
    problems = []
    for iid in ids:
        c = cache.get(iid)
        if not c:
            problems.append((iid, 'no preflight')); continue
        if c.get('status') != 'OK':
            problems.append((iid, c.get('status'))); continue
        now = image_id(r.make_test_spec(insts[iid]).image)
        if now != c.get('image_id'):
            problems.append((iid, 'image changed since preflight'))
    if problems:
        print(f'GATE FAIL: {len(problems)}/{len(ids)} instances cannot be trusted to score:')
        for iid, why in problems:
            print(f'  {why:30s} {iid}')
        return 1
    warned = [(iid, w) for iid in ids for w in cache[iid].get('warnings', [])]
    print(f'GATE OK: all {len(ids)} instances passed preflight on their current images'
          + (f' ({len(warned)} label warnings)' if warned else ''))
    for iid, w in warned:
        print(f'  warning {iid}: {w}')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dataset', default=DATASET)
    ap.add_argument('--cache-dir', default=str(DEFAULT_DIR))
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run'); r.add_argument('--instances', required=True); r.add_argument('--max-workers', type=int, default=4)
    r.add_argument('--reuse', action='store_true', help='skip instances already OK on the same image ID')
    g = sub.add_parser('gate'); g.add_argument('--predictions', required=True)
    a = ap.parse_args()
    sys.exit(cmd_run(a) if a.cmd == 'run' else cmd_gate(a))


if __name__ == '__main__':
    main()
