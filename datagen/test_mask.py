#!/usr/bin/env python3
# Prove the assistant-only label mask is CORRECT on real rows before it goes near a paid run.
# Approach: render text, find assistant-generated char spans via the UNAMBIGUOUS gemma4 markers
# (model-turn content minus <|tool_response>..<tool_response|> spans), map char spans -> token
# labels via offset_mapping. Then assert invariants on real data:
#   (A) every assistant tool_call NAME appears in the labeled (trainable) text
#   (B) every assistant free-text summary appears in the labeled text
#   (C) NO tool_response VALUE leaks into labeled text (don't train on environment output)
#   (D) NO system/tool-declaration text leaks into labeled text
#   (E) mask is non-empty for every row
import os, json, re, sys
os.environ["HF_HUB_OFFLINE"]="1"; os.environ["TRANSFORMERS_OFFLINE"]="1"
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained("unsloth/gemma-4-E4B-it")
print("fast tokenizer:", tok.is_fast)

# A model block runs from "<|turn>model\n" to the next "<turn|>" OR end-of-text (trajectories that
# end on a tool result leave the final model block unclosed — still contains labelable tool_calls).
MODEL_BLOCK = re.compile(r"<\|turn>model\n(.*?)(?:<turn\|>|\Z)", re.DOTALL)
TOOL_RESP   = re.compile(r"<\|tool_response>.*?<tool_response\|>", re.DOTALL)

def assistant_char_spans(txt):
    """Char spans that are assistant-GENERATED: inside a model turn, excluding tool_response blocks."""
    spans = []
    for mt in MODEL_BLOCK.finditer(txt):
        bstart, block = mt.start(1), mt.group(1)
        last = 0
        for tr in TOOL_RESP.finditer(block):
            if tr.start() > last:
                spans.append((bstart + last, bstart + tr.start()))
            last = tr.end()
        if last < len(block):
            spans.append((bstart + last, bstart + len(block)))
        if mt.group(0).endswith("<turn|>"):
            spans.append((mt.end(1), mt.end()))  # include the closing <turn|> (learn to stop)
    return spans

def build_labels(txt):
    enc = tok(txt, add_special_tokens=False, return_offsets_mapping=True)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    spans = assistant_char_spans(txt)
    labels = [-100] * len(ids)
    for k, (a, b) in enumerate(offs):
        if a == b:  # zero-width (specials)
            # a special token (e.g. <|tool_call>, <tool_call|>, <turn|>) inside an assistant span: label it
            if any(s <= a < e for (s, e) in spans):
                labels[k] = ids[k]
            continue
        if any(s <= a and b <= e for (s, e) in spans):
            labels[k] = ids[k]
    return ids, labels, spans

PATH = sys.argv[1] if len(sys.argv) > 1 else "kaggle/ds-longctx/train.jsonl"
NMAX = int(sys.argv[2]) if len(sys.argv) > 2 else 60
fails = {"A":0,"B":0,"C":0,"D":0,"E":0}; fracs=[]; checked=0
for i, line in enumerate(open(PATH)):
    if i >= NMAX: break
    d = json.loads(line); msgs, tools = d["messages"], d.get("tools")
    txt = tok.apply_chat_template(msgs, tools=tools, tokenize=False)
    ids, labels, spans = build_labels(txt)
    labeled_ids = [t for t, l in zip(ids, labels) if l != -100]
    labeled_txt = tok.decode(labeled_ids)
    nlab = len(labeled_ids)
    fracs.append(nlab/len(ids) if ids else 0)
    if nlab == 0: fails["E"] += 1

    callnames = [tc["function"]["name"] for m in msgs if m.get("role")=="assistant" and m.get("tool_calls") for tc in m["tool_calls"]]
    texts = [(m.get("content") or "").strip() for m in msgs if m.get("role")=="assistant" and (m.get("content") or "").strip()]
    tool_vals = [(m.get("content") or "") for m in msgs if m.get("role")=="tool"]
    sys_txt = (msgs[0].get("content") or "") if msgs and msgs[0].get("role")=="system" else ""

    # (A) all tool_call names present in labeled text
    if any(c not in labeled_txt for c in callnames): fails["A"] += 1
    # (B) all assistant summaries present
    if any(t[:60] not in labeled_txt for t in texts): fails["B"] += 1
    # (C) no tool_response value leaks: sample a distinctive 40-char slice of each tool value
    leak_c = False
    for tv in tool_vals:
        s = tv.strip()
        if len(s) >= 40:
            probe = s[10:50]
            if probe and probe in labeled_txt: leak_c = True; break
    if leak_c: fails["C"] += 1
    # (D) no system text leak: probe a slice from deep in the system prompt
    if len(sys_txt) >= 200:
        probe = sys_txt[120:170]
        if probe and probe in labeled_txt: fails["D"] += 1

    if checked < 2:
        print(f"\n[row {i}] tokens={len(ids)} labeled={nlab} ({100*nlab/len(ids):.2f}%)  "
              f"callnames={len(callnames)} summaries={len(texts)}")
        print(f"  labeled head: {labeled_txt[:160]!r}")
        print(f"  labeled tail: {labeled_txt[-120:]!r}")
        checked += 1

fracs.sort()
print(f"\n==== {min(NMAX, i+1)} rows ====")
print(f"labeled fraction: p50={100*fracs[len(fracs)//2]:.2f}%  min={100*fracs[0]:.2f}%  max={100*fracs[-1]:.2f}%")
print(f"FAILS: A(callname-missing)={fails['A']} B(summary-missing)={fails['B']} "
      f"C(toolresp-leak)={fails['C']} D(system-leak)={fails['D']} E(empty-mask)={fails['E']}")
print("RESULT:", "ALL INVARIANTS PASS ✅" if sum(fails.values())==0 else "INVARIANT VIOLATIONS ❌")
