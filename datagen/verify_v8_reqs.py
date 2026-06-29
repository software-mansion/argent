#!/usr/bin/env python3
"""Verify the 5 fundamental v8-training-data requirements against the v7 dataset (ds-longctx).
Measures with the REAL gemma-4-E4B tokenizer (cached). Reports PASS/FAIL per requirement with numbers.

Requirements (from the user):
  1. ALL `system` prompts are at least in the 30k-token ballpark.
  2. Prompt-length distribution spans 30-80k.
  3. Harness mix opencode/claude-code/codex/hermes  (hermes <=10%, codex <=20%).
  4. Minimized task duplication.
  5. Covers ALL basic navigation tools + extras for booting/opening apps + supporting tools.
"""
import json, sys, os, re, statistics as st
from collections import Counter
from transformers import AutoTokenizer

DATA = sys.argv[1] if len(sys.argv) > 1 else "kaggle/ds-longctx/train.jsonl"
TOK_SRC = "unsloth/gemma-4-E4B-it"

print(f"== loading gemma tokenizer ({TOK_SRC}) ==", flush=True)
tok = AutoTokenizer.from_pretrained(TOK_SRC)

# ---- harness detection from tool-name convention on the wire ----
#   opencode:  argent_<canon>          (dashes kept)        e.g. argent_list-devices
#   claude:    mcp__argent__<canon>    (dashes kept)        e.g. mcp__argent__list-devices
#   hermes:    mcp_argent_<canon_>     (de-dashed)          e.g. mcp_argent_list_devices
#   codex:     <canon_>                (de-dashed, bare)    e.g. list_devices
def detect_harness(row):
    names = []
    for m in row["messages"]:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for c in m["tool_calls"]:
                names.append(c["function"]["name"])
    # also look at offered tool names as a fallback
    offered = [t["function"]["name"] for t in row.get("tools", [])]
    probe = names or offered
    if not probe:
        return "unknown"
    n = probe[0]
    if n.startswith("mcp__argent__"):
        return "claude-code"
    if n.startswith("mcp_argent_"):
        return "hermes"
    if n.startswith("argent_"):
        return "opencode"
    return "codex"  # bare de-dashed

def canon(name):
    """Strip harness prefix -> canonical Argent tool name (de-dashed forms -> dashed)."""
    if name.startswith("mcp__argent__"):
        return name[len("mcp__argent__"):]
    if name.startswith("mcp_argent_"):
        return name[len("mcp_argent_"):].replace("_", "-")
    if name.startswith("argent_"):
        return name[len("argent_"):]
    return name.replace("_", "-")  # codex bare de-dashed

# Tool taxonomy for requirement 5.
BASIC_NAV = {"describe", "gesture-tap", "gesture-swipe", "gesture-scroll", "keyboard", "button"}
BOOT_OPEN = {"list-devices", "boot-device", "launch-app", "open-url", "restart-app", "reinstall-app", "shutdown-device"}
SUPPORT = {"gesture-pinch", "gesture-rotate", "gesture-drag", "gesture-custom", "run-sequence",
           "rotate", "screenshot", "inspect", "wait", "find", "list-apps"}

def main():
    rows = [json.loads(l) for l in open(DATA)]
    print(f"== {len(rows)} rows from {DATA} ==", flush=True)

    sys_tokens = []        # tokens of the system message alone
    pre_tokens = []        # tokens of the harness PREAMBLE = system + tool schemas (+ first user msg)
    full_tokens = []       # tokens of the full rendered sequence (the "prompt" the model sees)
    harness_count = Counter()
    tasks = []
    called_canon = Counter()   # canonical tool names actually CALLED
    offered_canon = Counter()  # canonical tool names OFFERED

    # batch the tokenization of system messages and full templates
    sys_texts, pre_texts, full_texts = [], [], []
    for r in rows:
        h = detect_harness(r); harness_count[h] += 1
        sysmsg = next((m["content"] for m in r["messages"] if m.get("role") == "system"), "") or ""
        sys_texts.append(sysmsg)
        # harness preamble = system + tool schemas + first user msg (what the model conditions on
        # before acting — the meaningful "system prompt size" of a real agent harness).
        sysm = [m for m in r["messages"] if m.get("role") == "system"][:1]
        usr = [m for m in r["messages"] if m.get("role") == "user"][:1]
        try:
            pre = tok.apply_chat_template(sysm + usr, tools=r.get("tools"), tokenize=False, add_generation_prompt=True)
        except Exception:
            pre = sysmsg
        pre_texts.append(pre)
        try:
            full = tok.apply_chat_template(r["messages"], tools=r.get("tools"), tokenize=False)
        except Exception as e:
            full = "\n".join(m.get("content") or "" for m in r["messages"])
        full_texts.append(full)
        usr = next((m["content"] for m in r["messages"] if m.get("role") == "user"), "") or ""
        tasks.append(usr.strip())
        for m in r["messages"]:
            if m.get("role") == "assistant" and m.get("tool_calls"):
                for c in m["tool_calls"]:
                    called_canon[canon(c["function"]["name"])] += 1
        for t in r.get("tools", []):
            offered_canon[canon(t["function"]["name"])] += 1

    print("== tokenizing (batched) ==", flush=True)
    B = 256
    def enc_lens(texts):
        out = []
        for i in range(0, len(texts), B):
            chunk = texts[i:i+B]
            ids = tok(chunk, add_special_tokens=False)["input_ids"]
            out.extend(len(x) for x in ids)
            print(f"  {min(i+B,len(texts))}/{len(texts)}", end="\r", flush=True)
        print()
        return out
    sys_tokens = enc_lens(sys_texts)
    pre_tokens = enc_lens(pre_texts)
    full_tokens = enc_lens(full_texts)

    def pct(vals, p):
        s = sorted(vals); k = (len(s)-1)*p/100
        f = int(k); c = min(f+1, len(s)-1)
        return s[f] + (s[c]-s[f])*(k-f)

    def summ(vals):
        return (f"min={min(vals):,} p10={pct(vals,10):,.0f} p50={pct(vals,50):,.0f} "
                f"p90={pct(vals,90):,.0f} max={max(vals):,} mean={st.mean(vals):,.0f}")

    print("\n" + "="*78)
    print("REQUIREMENT 1 — harness preamble (system + tool catalog) >= 30k tokens")
    print("="*78)
    print(f"  PREAMBLE (system+tools+user) tokens: {summ(pre_tokens)}")
    print(f"  (system message ALONE: {summ(sys_tokens)})")
    below30 = sum(1 for x in pre_tokens if x < 30000)
    print(f"  rows with preamble < 30k tokens: {below30}/{len(pre_tokens)} ({100*below30/len(pre_tokens):.1f}%)")
    r1 = below30 == 0
    print(f"  >>> {'PASS' if r1 else 'FAIL'}  (min preamble = {min(pre_tokens):,} tok)")

    print("\n" + "="*78)
    print("REQUIREMENT 2 — prompt-length distribution spans 30-80k")
    print("="*78)
    print(f"  FULL sequence tokens: {summ(full_tokens)}")
    in_band = sum(1 for x in full_tokens if 30000 <= x <= 80000)
    above40 = sum(1 for x in full_tokens if x > 40000)
    above50 = sum(1 for x in full_tokens if x > 50000)
    print(f"  rows in [30k,80k]: {in_band}/{len(full_tokens)} ({100*in_band/len(full_tokens):.1f}%)")
    print(f"  rows > 40k: {above40}  | > 50k: {above50}  | max: {max(full_tokens):,}")
    print(f"  >>> spans 30-80k? a TRUE 30-80k spread needs meaningful mass above ~50k.")

    print("\n" + "="*78)
    print("REQUIREMENT 3 — harness mix (hermes<=10%, codex<=20%)")
    print("="*78)
    tot = sum(harness_count.values())
    for h in ["opencode", "claude-code", "codex", "hermes", "unknown"]:
        c = harness_count.get(h, 0)
        print(f"  {h:14s}: {c:5d}  ({100*c/tot:.1f}%)")
    herm = 100*harness_count.get("hermes",0)/tot
    cod = 100*harness_count.get("codex",0)/tot
    r3 = herm <= 10.0 and cod <= 20.0
    print(f"  >>> {'PASS' if r3 else 'FAIL'}  (hermes {herm:.1f}% <=10%, codex {cod:.1f}% <=20%)")

    print("\n" + "="*78)
    print("REQUIREMENT 4 — minimized task duplication")
    print("="*78)
    tc = Counter(tasks)
    uniq = len(tc); total = len(tasks)
    print(f"  unique task strings: {uniq}/{total} ({100*uniq/total:.1f}% unique)")
    print(f"  top repeated tasks:")
    for t, c in tc.most_common(8):
        print(f"    {c:4d}x  {t[:80]!r}")
    # normalized (lowercase, collapse ws) to catch trivial variants
    norm = Counter(re.sub(r"\s+"," ",t.lower()).strip() for t in tasks)
    print(f"  unique after normalize: {len(norm)}/{total} ({100*len(norm)/total:.1f}%)")

    print("\n" + "="*78)
    print("REQUIREMENT 5 — tool coverage (basic nav + boot/open + support)")
    print("="*78)
    def cov(label, group, counter):
        present = {t for t in group if counter.get(t,0) > 0}
        missing = group - present
        print(f"  {label}: {len(present)}/{len(group)} present")
        for t in sorted(group):
            print(f"    {'OK ' if t in present else 'MISS'} {t:18s} called={called_canon.get(t,0):5d} offered={offered_canon.get(t,0):5d}")
        return missing
    m1 = cov("BASIC NAV", BASIC_NAV, called_canon)
    m2 = cov("BOOT/OPEN", BOOT_OPEN, called_canon)
    print(f"  SUPPORT tools seen (called): {sorted(t for t in SUPPORT if called_canon.get(t,0))}")
    print(f"  ALL canonical tools ever CALLED ({len(called_canon)}): {sorted(called_canon)}")
    r5_basic = not m1
    print(f"  >>> basic-nav complete? {'PASS' if r5_basic else 'FAIL (missing '+str(sorted(m1))+')'}")
    print(f"  >>> boot/open missing: {sorted(m2) if m2 else 'none'}")

    print("\n" + "="*78)
    print("SUMMARY")
    print("="*78)
    print(f"  R1 preamble>=30k:  {'PASS' if r1 else 'FAIL'}  (min {min(pre_tokens):,})")
    print(f"  R2 spans 30-80k:   p50={pct(full_tokens,50):,.0f} max={max(full_tokens):,}  >50k={above50} ({100*above50/len(full_tokens):.0f}%)")
    print(f"  R3 harness mix:    {'PASS' if r3 else 'FAIL'}")
    print(f"  R4 dedup:          {100*uniq/total:.1f}% unique raw / {100*len(norm)/total:.1f}% normalized")
    print(f"  R5 basic-nav:      {'PASS' if r5_basic else 'FAIL'}")

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    main()
