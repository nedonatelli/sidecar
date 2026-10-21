"""Claude Code headless on a SWE-bench slice -> official predictions JSONL.

A reference agent for SideCar's SWE numbers: same tasks, same model, same
scorer (bench/swe/local/score_local.sh), different harness.

Each task gets a fresh clone of the cached repo at base_commit, the same uv
venv SideCar's driver builds (when one exists), and stock Claude Code: an
empty CLAUDE_CONFIG_DIR, so none of the operator's plugins, hooks, MCP servers
or CLAUDE.md load. The patch is `git diff <base_commit>` of tracked files.

Usage (from repo root, with ANTHROPIC_API_KEY set):
    python3 -I bench/swe/baselines/claude_code.py <out_dir>
Env: MODEL (claude-haiku-4-5-20251001), N (50), SLICE (canary), FILTER (one
instance id), TASK_TIMEOUT seconds (1200, matching SideCar's per-task timeout).

The agent runs with --permission-mode bypassPermissions, directly on the host,
in the task clone. Rerunning skips instances already in the predictions file.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SLICE = Path(os.environ.get("SLICE", REPO_ROOT / "bench/swe/data/canary.jsonl"))
CACHE = REPO_ROOT / ".sidecar/cache/swe-repos"
SPECS = json.loads((REPO_ROOT / "bench/swe/data/env-specs.json").read_text())
MODEL = os.environ.get("MODEL", "claude-haiku-4-5-20251001")
N = int(os.environ.get("N", "50"))
FILTER = os.environ.get("FILTER")
TASK_TIMEOUT = int(os.environ.get("TASK_TIMEOUT", "1200"))


def sh(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout


def prompt_for(task, test_cmd):
    env_note = (
        f"The repository's dependencies are installed in the active Python environment. "
        f"Its test command is: {test_cmd}\n\n"
        if test_cmd
        else ""
    )
    return (
        "Resolve this GitHub issue in the repository in the current directory. "
        "Make the code change that fixes it. Do not commit.\n\n"
        f"{env_note}Issue:\n{task['problem_statement']}"
    )


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1]).resolve()
    work, config = out / "work", out / "claude-config"
    for d in (out, work, config):
        d.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(l) for l in SLICE.read_text().splitlines() if l.strip()]
    rows.sort(key=lambda r: r["instance_id"])
    rows = rows[:N]
    if FILTER:
        rows = [r for r in rows if r["instance_id"] == FILTER]
    preds_path = out / "preds.claude-code.jsonl"
    meta_path = out / "meta.claude-code.jsonl"
    done = set()
    if preds_path.exists():
        done = {json.loads(l)["instance_id"] for l in preds_path.read_text().splitlines() if l.strip()}

    for task in rows:
        iid = task["instance_id"]
        if iid in done:
            continue
        repo_dir = work / iid
        shutil.rmtree(repo_dir, ignore_errors=True)
        src = CACHE / task["repo"].replace("/", "_")
        if not (src / ".git").is_dir():
            sh(["git", "clone", "--quiet", f"https://github.com/{task['repo']}.git", str(src)])
        sh(["git", "clone", "--quiet", "--shared", str(src), str(repo_dir)])
        sh(["git", "checkout", "--quiet", task["base_commit"]], cwd=repo_dir)

        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        env["CLAUDE_CONFIG_DIR"] = str(config)
        spec = SPECS.get(task["repo"], {}).get(task["version"])
        venv = CACHE / "venvs" / f"{task['repo'].replace('/', '_')}@{task['version']}"
        test_cmd = None
        if venv.is_dir():
            env["VIRTUAL_ENV"] = str(venv)
            env["PATH"] = f"{venv}/bin:{env['PATH']}"
            test_cmd = spec.get("test_cmd") if spec else None

        start = time.time()
        log_path = out / f"{iid}.stream.jsonl"
        status, cost, turns = "ok", None, None
        try:
            with open(log_path, "w") as log:
                subprocess.run(
                    [
                        "claude", "-p", prompt_for(task, test_cmd),
                        "--model", MODEL,
                        "--permission-mode", "bypassPermissions",
                        "--output-format", "stream-json", "--verbose",
                        "--no-session-persistence",
                    ],
                    cwd=repo_dir, env=env, stdout=log, stderr=subprocess.STDOUT,
                    timeout=TASK_TIMEOUT,
                )
        except subprocess.TimeoutExpired:
            status = "timeout"
        for line in log_path.read_text().splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "result":
                cost, turns = ev.get("total_cost_usd"), ev.get("num_turns")
                if ev.get("is_error"):
                    status = f"error:{ev.get('subtype')}"
        patch = sh(["git", "diff", task["base_commit"]], cwd=repo_dir)
        secs = round(time.time() - start)
        with open(preds_path, "a") as f:
            f.write(json.dumps({"instance_id": iid, "model_name_or_path": f"claude-code/{MODEL}",
                                "model_patch": patch}) + "\n")
        with open(meta_path, "a") as f:
            f.write(json.dumps({"instance_id": iid, "status": status, "seconds": secs, "turns": turns,
                                "cost_usd": cost, "patch_bytes": len(patch), "venv": venv.is_dir()}) + "\n")
        print(f"[cc] {iid}: {status} {len(patch)}b patch ({secs}s, {turns} turns, ${cost})", flush=True)
        shutil.rmtree(repo_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
