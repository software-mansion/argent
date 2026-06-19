#!/usr/bin/env python3
"""Score benchmark cells for task success.

Hermes (the harness) runs the agent and gives us transcripts; it has no notion of
task success, so we add a thin scoring pass — the standard LLM-as-judge pattern,
not a custom agent loop.

  python judge.py out/argent_silver               # score one cell -> writes scores.json
  python judge.py --table out/*/                  # print the cross-cell comparison

Judge backend:
  - If ANTHROPIC_API_KEY is set, a Claude model (JUDGE_MODEL, default claude-haiku-4-5)
    reads each task's goal + transcript and returns pass/fail + reason. This is the
    real judgment (use once the key is supplied).
  - Otherwise a labeled HEURISTIC proxy ("did the agent drive the toolkit + answer?")
    so cells run now produce a preliminary signal; rerun with the key for real scores.
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


def anthropic_judge(prompt, goal, transcript):
    body = json.dumps(
        {
            "model": JUDGE_MODEL,
            "max_tokens": 300,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "You are grading whether a device-control agent accomplished a task.\n\n"
                        f"TASK GIVEN TO AGENT:\n{prompt}\n\nSUCCESS CRITERION:\n{goal}\n\n"
                        f"AGENT TRANSCRIPT (tool calls + responses + final answer):\n{transcript[:14000]}\n\n"
                        "Did the agent actually accomplish the success criterion via real tool "
                        "calls on the device (not just claim it)? Reply with a single JSON object: "
                        '{"pass": true|false, "reason": "<one sentence>"}'
                    ),
                }
            ],
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        txt = json.load(r)["content"][0]["text"]
    s = txt[txt.find("{") : txt.rfind("}") + 1]
    v = json.loads(s)
    return bool(v.get("pass")), v.get("reason", ""), "llm"


def heuristic_judge(prompt, goal, transcript, answer):
    # Proxy ONLY: did the agent drive the toolkit (>=2 tool calls incl. a tap/click)
    # and produce a non-trivial final answer? Not a real success judgment.
    tcalls = transcript.count("tool_call") + transcript.lower().count('"name"')
    acted = any(
        k in transcript.lower()
        for k in ("tap", "click", "launch", "open", "scroll", "snapshot", "describe", "screenshot")
    )
    answered = len(answer.strip()) > 15
    proxy = tcalls >= 2 and acted and answered
    return proxy, f"proxy: tool_signals={tcalls} acted={acted} answered={answered}", "heuristic"


def score_cell(cell: Path):
    rows = []
    for tid, task in TASKS.items():
        answer = (cell / f"{tid}.answer.txt").read_text() if (cell / f"{tid}.answer.txt").exists() else ""
        tpath = cell / f"{tid}.transcript.jsonl"
        transcript = tpath.read_text() if tpath.exists() else answer
        try:
            if KEY:
                ok, reason, backend = anthropic_judge(task["prompt"], task["goal"], transcript)
            else:
                ok, reason, backend = heuristic_judge(task["prompt"], task["goal"], transcript, answer)
        except Exception as e:  # never let one task break the cell
            ok, reason, backend = False, f"judge-error: {e}", "error"
        rows.append({"id": tid, "pass": ok, "reason": reason, "backend": backend})
    passed = sum(r["pass"] for r in rows)
    summary = {"cell": cell.name, "n": len(rows), "passed": passed,
               "success_pct": round(100 * passed / max(1, len(rows)), 1),
               "backend": rows[0]["backend"] if rows else "n/a", "rows": rows}
    (cell / "scores.json").write_text(json.dumps(summary, indent=2))
    print(f"{cell.name}: {passed}/{len(rows)} ({summary['success_pct']}%) [{summary['backend']}]")
    for r in rows:
        print(f"   {'PASS' if r['pass'] else 'fail'}  {r['id']:20s} {r['reason'][:80]}")
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
