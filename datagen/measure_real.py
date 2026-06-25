#!/usr/bin/env python3
# Pedantic ground-truth on the EXACT uploaded data, with the REAL gemma-4-E4B tokenizer (cached, CPU/offline).
# Answers, with no estimation:
#   1) real token distribution -> is MAXLEN=40960 safe? how many rows truncate?
#   2) does apply_chat_template(tools=...) even render tool defs + tool_calls? (train-format reality)
#   3) full-sequence loss dilution: what % of tokens are assistant (the only thing worth learning)?
#   4) would right-truncation at 40960 cut the FINAL assistant turn (kill the label)?
import os, json, sys
os.environ["HF_HUB_OFFLINE"] = "1"; os.environ["TRANSFORMERS_OFFLINE"] = "1"
from transformers import AutoTokenizer

PATH = sys.argv[1] if len(sys.argv) > 1 else "kaggle/ds-longctx/train.jsonl"
MAXLEN = 40960
tok = AutoTokenizer.from_pretrained("unsloth/gemma-4-E4B-it")

def render(messages, tools):
    return tok.apply_chat_template(messages, tools=tools, tokenize=True, add_generation_prompt=False)["input_ids"]

lens, over_maxlen, over_38k, dilutions, last_turn_cut = [], 0, 0, [], 0
tool_render_ok = None
render_err = None
first_dump_done = False
N = sum(1 for _ in open(PATH))
print(f"rows={N}  MAXLEN={MAXLEN}", flush=True)
for i, line in enumerate(open(PATH)):
    d = json.loads(line)
    msgs, tools = d["messages"], d.get("tools")
    try:
        ids = render(msgs, tools)
    except Exception as e:
        render_err = repr(e)
        print(f"!! apply_chat_template FAILED on row {i}: {render_err}", flush=True)
        break
    L = len(ids)
    lens.append(L)
    if L > MAXLEN: over_maxlen += 1
    if L > 38000: over_38k += 1

    # tool-format reality check on the first row: does the rendered text actually contain tool defs?
    if not first_dump_done:
        txt = tok.apply_chat_template(msgs, tools=tools, tokenize=False)
        names = [t["function"]["name"] if "function" in t else t.get("name") for t in (tools or [])]
        hit = sum(1 for n in names if n and n in txt)
        tool_render_ok = (len(tools or []), hit)
        # find an assistant tool_call to see the serialized call format
        ex = ""
        for m in msgs:
            if m.get("role") == "assistant" and m.get("tool_calls"):
                idx = txt.find(m["tool_calls"][0]["function"]["name"])
                if idx >= 0: ex = txt[max(0, idx-80): idx+260]
                break
        print(f"\n--- TRAIN-FORMAT (row {i}) ---", flush=True)
        print(f"tools in array={len(tools or [])}  names present in rendered text={hit}", flush=True)
        print(f"first 6 tool-array names: {[n for n in names[:6]]}", flush=True)
        callnames = [tc['function']['name'] for m in msgs if m.get('role')=='assistant' and m.get('tool_calls') for tc in m['tool_calls']]
        print(f"assistant tool_call names (first 6): {callnames[:6]}", flush=True)
        print(f"tool-call serialization sample:\n{ex!r}\n", flush=True)
        first_dump_done = True

    # dilution + last-turn-truncation: compute prompt-vs-completion split at the FINAL assistant turn.
    # prompt = everything up to and including add_generation_prompt before the last assistant msg.
    last_asst = max((j for j, m in enumerate(msgs) if m.get("role") == "assistant"), default=None)
    if last_asst is not None and last_asst > 0:
        try:
            prompt_ids = tok.apply_chat_template(msgs[:last_asst], tools=tools, tokenize=True, add_generation_prompt=True)["input_ids"]
            comp = L - len(prompt_ids)
            dilutions.append(comp / L if L else 0)
            if len(prompt_ids) >= MAXLEN:  # the final assistant turn starts at/after the cut -> label destroyed
                last_turn_cut += 1
        except Exception:
            pass
    if (i + 1) % 200 == 0:
        print(f"  ..{i+1}/{N}", flush=True)

lens.sort()
def pct(p): return lens[min(len(lens)-1, int(len(lens)*p))]
print("\n================ TOKEN DISTRIBUTION (real tokenizer) ================", flush=True)
print(f"count={len(lens)} min={lens[0]} p10={pct(.1)} p50={pct(.5)} p90={pct(.9)} p99={pct(.99)} max={lens[-1]}", flush=True)
print(f"rows > MAXLEN({MAXLEN}) = {over_maxlen}  ({100*over_maxlen/len(lens):.1f}%)  [these RIGHT-TRUNCATE]", flush=True)
print(f"rows > 38000          = {over_38k}", flush=True)
print(f"rows whose FINAL assistant turn starts >= MAXLEN (LABEL DESTROYED) = {last_turn_cut}", flush=True)
if dilutions:
    dilutions.sort()
    dm = dilutions[len(dilutions)//2]
    print(f"\nfull-seq loss dilution: median assistant-token fraction = {dm*100:.2f}%  "
          f"(=> {100-dm*100:.1f}% of loss is on STATIC prompt/tools/user)", flush=True)
print(f"\ntool render: {tool_render_ok}  render_err={render_err}", flush=True)
