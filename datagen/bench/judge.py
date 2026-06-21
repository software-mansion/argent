#!/usr/bin/env python3
"""Score benchmark cells (OpenCode JSON transcripts) for task success.

OpenCode (the harness) drives the model through the toolkit's MCP tools against a
real device and emits a JSON event stream per task; it has no notion of task
success, so we add a thin scoring pass — the standard LLM-as-judge pattern.

  python judge.py out/argent_gemma4            # score one cell -> scores.json
  python judge.py --table out/*/               # cross-cell comparison

Backend: ANTHROPIC_API_KEY set -> Claude (JUDGE_MODEL) reads goal + transcript and
returns pass/fail. Otherwise a labeled heuristic (did the agent execute real toolkit
tools AND answer?) gives a preliminary signal — rerun with the key for real scores.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
TASKS = {
    json.loads(l)["id"]: json.loads(l)
    for l in (HERE / "tasks.jsonl").read_text().splitlines()
    if l.strip()
}
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-haiku-4-5")
KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
DISCOVERY = ("describe", "component-tree", "screenshot")
ACTION = ("tap", "launch", "open-url", "swipe", "scroll", "keyboard", "button", "gesture")


def parse_opencode(path: Path):
    """Pull tool calls (name/status/input/output) + final text from an OpenCode run."""
    calls, texts = [], []
    if not path.exists():
        return {"calls": [], "final": "", "error": "no transcript"}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        t, part = e.get("type", ""), e.get("part", {})
        if t in ("tool", "tool_use") and part.get("tool"):
            st = part.get("state", {})
            calls.append(
                {
                    "name": part["tool"],
                    "status": st.get("status"),
                    "input": st.get("input"),
                    "output": str(st.get("output", ""))[:500],
                }
            )
        elif t == "text" and part.get("text"):
            texts.append(part["text"])
    return {"calls": calls, "final": "\n".join(texts).strip(), "error": None}


def transcript_text(run):
    lines = []
    for c in run["calls"]:
        lines.append(f"CALL {c['name']}({json.dumps(c['input'])}) -> [{c['status']}] {c['output'][:200]}")
    lines.append(f"FINAL: {run['final']}")
    return "\n".join(lines)


def anthropic_judge(prompt, goal, run):
    body = json.dumps(
        {
            "model": JUDGE_MODEL,
            "max_tokens": 300,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Grade whether a device-control agent accomplished a task on a real iOS simulator.\n\n"
                        f"TASK:\n{prompt}\n\nSUCCESS CRITERION:\n{goal}\n\n"
                        f"AGENT TOOL CALLS + FINAL ANSWER:\n{transcript_text(run)[:14000]}\n\n"
                        "Did the agent actually accomplish the criterion via real, successful tool calls "
                        '(not just claim it)? Reply with one JSON object: {"pass": true|false, "reason": "<one sentence>"}'
                    ),
                }
            ],
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        txt = json.load(r)["content"][0]["text"]
    v = json.loads(txt[txt.find("{") : txt.rfind("}") + 1])
    return bool(v.get("pass")), v.get("reason", ""), "llm"


def heuristic_judge(run):
    # Proxy ONLY: executed >=1 discovery + >=1 action tool successfully, and answered.
    ok_calls = [c for c in run["calls"] if c["status"] == "completed"]
    names = " ".join(c["name"] for c in ok_calls).lower()
    discovered = any(k in names for k in DISCOVERY)
    acted = any(k in names for k in ACTION)
    answered = len(run["final"]) > 15
    proxy = len(ok_calls) >= 2 and (discovered or acted) and answered
    return (
        proxy,
        f"proxy: ok_calls={len(ok_calls)} discovered={discovered} acted={acted} answered={answered}",
        "heuristic",
    )


def score_cell(cell: Path):
    rows = []
    for tid, task in TASKS.items():
        run = parse_opencode(cell / f"{tid}.json")
        try:
            if KEY:
                ok, reason, backend = anthropic_judge(task["prompt"], task["goal"], run)
            else:
                ok, reason, backend = heuristic_judge(run)
        except Exception as e:
            ok, reason, backend = False, f"judge-error: {e}", "error"
        rows.append({"id": tid, "pass": ok, "reason": reason, "backend": backend, "n_calls": len(run["calls"])})
    passed = sum(r["pass"] for r in rows)
    summary = {
        "cell": cell.name,
        "n": len(rows),
        "passed": passed,
        "success_pct": round(100 * passed / max(1, len(rows)), 1),
        "backend": rows[0]["backend"] if rows else "n/a",
        "rows": rows,
    }
    (cell / "scores.json").write_text(json.dumps(summary, indent=2))
    print(f"{cell.name}: {passed}/{len(rows)} ({summary['success_pct']}%) [{summary['backend']}]")
    for r in rows:
        print(f"   {'PASS' if r['pass'] else 'fail'}  {r['id']:20s} calls={r['n_calls']:2d}  {r['reason'][:72]}")
    return summary


def table(cells):
    sums = [json.loads((Path(c) / "scores.json").read_text()) for c in cells if (Path(c) / "scores.json").exists()]
    print(f"\n{'cell':32s} {'success':>9s}  {'backend':>10s}")
    print("-" * 56)
    for s in sorted(sums, key=lambda x: -x["success_pct"]):
        print(f"{s['cell']:32s} {s['success_pct']:>8.1f}%  {s['backend']:>10s}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--table":
        table(args[1:])
    else:
        for c in args:
            score_cell(Path(c))
