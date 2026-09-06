#!/usr/bin/env python3
"""Regenerate bench/swe/data/env-specs.json from swebench's authoritative
MAP_REPO_VERSION_TO_SPECS, for the (repo, version) pairs the committed canary
slice actually uses. Run inside a venv with swebench installed:

    python -m pip install swebench
    python bench/swe/local/gen_env_specs.py

Keeping the specs committed means swe.eval builds solve environments offline,
from the same source the official scorer uses (so solve and score can't drift).
"""
import json
import os

from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CANARY = os.path.join(ROOT, "bench", "swe", "data", "canary.jsonl")
OUT = os.path.join(ROOT, "bench", "swe", "data", "env-specs.json")

need: dict[str, set[str]] = {}
for line in open(CANARY):
    line = line.strip()
    if not line:
        continue
    t = json.loads(line)
    need.setdefault(t["repo"], set()).add(t.get("version"))

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

json.dump(out, open(OUT, "w"), indent=2, default=list, sort_keys=True)
print(f"wrote {OUT}: {sum(len(v) for v in out.values())} (repo,version) pairs")
