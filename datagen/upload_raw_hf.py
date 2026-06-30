#!/usr/bin/env python3
"""Publish the RAW trajectory inputs (the neutral RawTrajectory data a dataset version is rendered from)
to the HF dataset repo as a versioned, browsable config.

  python3 upload_raw_hf.py training/data-v9/raw.jsonl software-mansion/silver-datasets raw-v9
"""
import json, sys, os
from datasets import Dataset

RAW = sys.argv[1]
REPO = sys.argv[2]
CONFIG = sys.argv[3]
PRIVATE = "--public" not in sys.argv[4:]

def build(rows):
    out = []
    for r in rows:
        steps = r.get("steps", [])
        meta = r.get("meta", {})
        out.append({
            "id": meta.get("id", ""),
            "source": meta.get("source", ""),          # gym | real
            "app": meta.get("app", ""),
            "platform": meta.get("platform", ""),
            "task_kind": meta.get("task_kind", ""),
            "difficulty": meta.get("difficulty", "") or "",
            "n_steps": len(steps),
            "tool_sequence": " → ".join(s.get("call", {}).get("name", "") for s in steps),
            "task": (r.get("task") or "").strip(),
            "final_answer": (r.get("finalAnswer") or "").strip(),
            "trajectory": json.dumps(r, ensure_ascii=False),   # full RawTrajectory (JSON-encoded)
        })
    return out

rows = [json.loads(l) for l in open(RAW) if l.strip()]
ds = Dataset.from_list(build(rows))
print(f"pushing {len(rows)} raw trajectories -> {REPO} config={CONFIG} private={PRIVATE}", flush=True)
ds.push_to_hub(REPO, config_name=CONFIG, private=PRIVATE)
print(f"DONE: https://huggingface.co/datasets/{REPO} (config '{CONFIG}')", flush=True)
