#!/usr/bin/env python3
"""Regenerate bench/swe/data/env-specs.json from swebench's authoritative
MAP_REPO_VERSION_TO_SPECS, for the (repo, version) pairs the committed canary
slice uses, plus those of any dataset file given on the command line (JSON
array or JSONL, e.g. the full 300-task Lite export). Run inside a venv with
swebench installed:

    python -m pip install swebench
    python bench/swe/local/gen_env_specs.py [/path/to/swe_lite.jsonl ...]

Keeping the specs committed means swe.eval builds solve environments offline,
from the same source the official scorer uses (so solve and score can't drift).
"""
import json
import os
import sys

from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CANARY = os.path.join(ROOT, "bench", "swe", "data", "canary.jsonl")
OUT = os.path.join(ROOT, "bench", "swe", "data", "env-specs.json")



def tasks(path):
    text = open(path, encoding="utf-8").read().strip()
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# Ordered dicts, not sets, seeded with the committed file's order: a
# regeneration then only appends the pairs a new dataset adds instead of
# reshuffling the file.
need: dict[str, dict[str, None]] = {}
if os.path.exists(OUT):
    for repo, versions in json.load(open(OUT, encoding="utf-8")).items():
        need[repo] = dict.fromkeys(versions)
for path in [CANARY, *sys.argv[1:]]:
    for t in tasks(path):
        need.setdefault(t["repo"], {})[t.get("version")] = None

out: dict[str, dict] = {}
for repo, versions in need.items():
    specs = MAP_REPO_VERSION_TO_SPECS.get(repo, {})
    for ver in versions:
        s = specs.get(ver)
        if not s:
            continue
        out.setdefault(repo, {})[ver] = {
            "python": s.get("python"),
            "pre_install": s.get("pre_install"),
            "pip_packages": s.get("pip_packages"),
            "install": s.get("install"),
            "test_cmd": s.get("test_cmd"),
        }

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=2, default=list)
    f.write("\n")
print(f"wrote {OUT}: {sum(len(v) for v in out.values())} (repo,version) pairs")
