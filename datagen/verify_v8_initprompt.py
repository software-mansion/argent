#!/usr/bin/env python3
"""Addendum: measure the INITIAL PROMPT (system + tool schemas + first user msg, with generation prompt)
for every row — the fixed harness context the model sees BEFORE its first action. This is the honest
reading of 'system prompt size' (R1) and 'prompt distribution' (R2)."""
import json, sys, statistics as st
from transformers import AutoTokenizer
DATA = sys.argv[1] if len(sys.argv) > 1 else "kaggle/ds-longctx/train.jsonl"
tok = AutoTokenizer.from_pretrained("unsloth/gemma-4-E4B-it")
rows = [json.loads(l) for l in open(DATA)]
texts = []
for r in rows:
    msgs = r["messages"]
    sysm = [m for m in msgs if m.get("role") == "system"][:1]
    usr = [m for m in msgs if m.get("role") == "user"][:1]
    prompt_msgs = sysm + usr
    txt = tok.apply_chat_template(prompt_msgs, tools=r.get("tools"), tokenize=False, add_generation_prompt=True)
    texts.append(txt)
lens = []
B = 256
for i in range(0, len(texts), B):
    ids = tok(texts[i:i+B], add_special_tokens=False)["input_ids"]
    lens.extend(len(x) for x in ids)
def pct(v,p):
    s=sorted(v);k=(len(s)-1)*p/100;f=int(k);c=min(f+1,len(s)-1);return s[f]+(s[c]-s[f])*(k-f)
print(f"INITIAL PROMPT (system+tools+user) tokens over {len(lens)} rows:")
print(f"  min={min(lens):,} p10={pct(lens,10):,.0f} p50={pct(lens,50):,.0f} p90={pct(lens,90):,.0f} max={max(lens):,} mean={st.mean(lens):,.0f}")
print(f"  rows with init-prompt < 30k: {sum(1 for x in lens if x<30000)}/{len(lens)}")
print(f"  rows with init-prompt >= 30k: {sum(1 for x in lens if x>=30000)}/{len(lens)}")
