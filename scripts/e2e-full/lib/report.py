#!/usr/bin/env python3
"""Aggregate the E2E JSONL log into a markdown report.

Reads one JSON object per line: {phase, tool, case, status, detail}.
Emits: run header, per-phase pass/fail/skip summary, a per-tool coverage
matrix (was each tool validated? happy-path run?), and the full list of
failures with the exact case so a release engineer can reproduce.
"""
import json
import os
import sys
from collections import defaultdict, OrderedDict

DEVICE_PHASES = {"android", "chromium", "rn"}


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("E2E_JSONL", "")
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    version = os.environ.get("TGZ_VERSION", "?")
    osname = os.environ.get("E2E_OS", "?")
    binname = os.environ.get("ARGENT_BIN", "?")

    total = defaultdict(int)
    per_phase = defaultdict(lambda: defaultdict(int))
    tools = OrderedDict()  # tool -> {"validation": status, "happy": status}
    fails = []

    for r in rows:
        st = r.get("status", "?")
        ph = r.get("phase", "?")
        tool = r.get("tool", "?")
        total[st] += 1
        per_phase[ph][st] += 1
        tools.setdefault(tool, {"validated": False, "happy": None})
        if ph == "validation":
            if st == "pass":
                tools[tool]["validated"] = True
        if ph in DEVICE_PHASES:
            cur = tools[tool]["happy"]
            # a single pass anywhere marks the tool happy-path covered
            if st == "pass":
                tools[tool]["happy"] = "pass"
            elif st == "fail" and cur != "pass":
                tools[tool]["happy"] = "fail"
            elif st == "skip" and cur is None:
                tools[tool]["happy"] = "skip"
        if st == "fail":
            fails.append(r)

    out = []
    w = out.append
    w(f"# Argent full E2E report\n")
    w(f"- **package:** `@swmansion/argent` v{version}")
    w(f"- **os:** {osname}")
    w(f"- **driver:** `{binname}`")
    w(f"- **totals:** ✅ {total['pass']} pass · ❌ {total['fail']} fail · ∼ {total['skip']} skip"
      f" ({sum(total.values())} cases)\n")

    # Per-phase summary
    w("## Per-phase\n")
    w("| phase | pass | fail | skip |")
    w("|---|---:|---:|---:|")
    order = ["install", "introspection", "validation", "android", "chromium", "rn", "cleanup"]
    seen = [p for p in order if p in per_phase] + [p for p in per_phase if p not in order]
    for p in seen:
        d = per_phase[p]
        w(f"| {p} | {d['pass']} | {d['fail']} | {d['skip']} |")
    w("")

    # Coverage matrix
    w("## Tool coverage\n")
    w(f"{len(tools)} tools observed. `validated` = argument-schema rejection tests passed; "
      "`happy-path` = a real device/app run (or why it was skipped).\n")
    w("| tool | validated | happy-path |")
    w("|---|:---:|:---:|")

    def mark(v):
        return {True: "✅", False: "—", None: "·", "pass": "✅", "fail": "❌", "skip": "∼"}.get(v, "?")

    for tool in sorted(tools):
        t = tools[tool]
        w(f"| `{tool}` | {mark(t['validated'])} | {mark(t['happy'])} |")
    w("")

    # Failures
    w("## Failures\n")
    if not fails:
        w("None. 🎉\n")
    else:
        for f in fails:
            w(f"- **[{f.get('phase')}] `{f.get('tool')}` — {f.get('case')}**: "
              f"{f.get('detail','').strip()}")
        w("")

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
