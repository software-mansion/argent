#!/usr/bin/env python3
"""Publish a silver training dataset to the Hugging Face Hub, VERSIONED + BROWSABLE.

Each version goes in as its own HF *config* (e.g. v8, v9) of one dataset repo, so the HF dataset
viewer gets a version dropdown. Every row keeps the full `messages`/`tools` (JSON-encoded strings, so
the viewer renders them cleanly and the variable tool-schemas don't break Arrow inference) plus derived
browsable columns: harness, start_state, task, tool_sequence, n_steps, final_answer, token sizes.

  python3 upload_hf.py training/data-v8 latekvo/silver-nav v8           # private (default)
  python3 upload_hf.py training/data-v8 latekvo/silver-nav v8 --public
"""
import json, sys, os
from datasets import Dataset, DatasetDict

DATA_DIR = sys.argv[1]
REPO = sys.argv[2]
CONFIG = sys.argv[3]
PRIVATE = "--public" not in sys.argv[4:]

def canon(name):
    if name.startswith("mcp__argent__"): return name[len("mcp__argent__"):]
    if name.startswith("mcp_argent_"):   return name[len("mcp_argent_"):].replace("_", "-")
    if name.startswith("argent_"):        return name[len("argent_"):]
    return name.replace("_", "-")

def harness_of(r):
    names = [c["function"]["name"] for m in r["messages"]
             if m.get("role") == "assistant" and m.get("tool_calls") for c in m["tool_calls"]]
    names = names or [t["function"]["name"] for t in r.get("tools", [])]
    n = names[0] if names else ""
    if n.startswith("mcp__argent__"): return "claude-code"
    if n.startswith("mcp_argent_"):   return "hermes"
    if n.startswith("argent_"):        return "opencode"
    return "codex"

SETUP = {"list-devices", "boot-device"}
def start_state(first_canon):
    if first_canon in SETUP: return "cold"
    if first_canon in ("launch-app", "open-url"): return "warm_device"
    return "warm_app"

SPAM = ["Available Skills", "CLAUDE.md", "AGENTS.md", "# Memory", "hyperframes", "pptx"]

def build(rows):
    out = []
    for r in rows:
        msgs, tools = r["messages"], r.get("tools", [])
        sysm = next((m.get("content") or "" for m in msgs if m["role"] == "system"), "")
        usr = next((m.get("content") or "" for m in msgs if m["role"] == "user"), "")
        calls = [canon(c["function"]["name"]) for m in msgs
                 if m.get("role") == "assistant" and m.get("tool_calls") for c in m["tool_calls"]]
        final = next((m.get("content") or "" for m in reversed(msgs)
                      if m["role"] == "assistant" and m.get("content") and not m.get("tool_calls")), "")
        out.append({
            "harness": harness_of(r),
            "start_state": start_state(calls[0]) if calls else "none",
            "task": usr.strip(),
            "tool_sequence": " → ".join(calls),
            "n_steps": len(calls),
            "n_tools_offered": len(tools),
            "final_answer": final.strip(),
            "system_chars": len(sysm),
            "system_blocks": ", ".join(b for b in SPAM if b in sysm),
            "messages": json.dumps(msgs, ensure_ascii=False),   # full record (JSON-encoded)
            "tools": json.dumps(tools, ensure_ascii=False),
        })
    return out

train = [json.loads(l) for l in open(os.path.join(DATA_DIR, "train.jsonl"))]
valid = [json.loads(l) for l in open(os.path.join(DATA_DIR, "valid.jsonl"))]
dd = DatasetDict({
    "train": Dataset.from_list(build(train)),
    "validation": Dataset.from_list(build(valid)),
})
print(f"pushing {len(train)} train + {len(valid)} valid -> {REPO} config={CONFIG} private={PRIVATE}", flush=True)
dd.push_to_hub(REPO, config_name=CONFIG, private=PRIVATE)
print(f"DONE: https://huggingface.co/datasets/{REPO} (config '{CONFIG}')", flush=True)
