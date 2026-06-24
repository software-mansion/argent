# Eval the trained adapter (mounted from silver-train's output via kernel_sources) on the exact prod
# failure scenarios. Robust generate path (render text -> tok.tokenizer -> generate -> decode).
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, subprocess, torch, glob

print("GPU:", subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                             capture_output=True, text=True).stdout.strip(), flush=True)
assert torch.cuda.get_device_capability(0)[0] >= 7, "need T4"
os.system("find /kaggle/input -maxdepth 6 -name adapter_config.json 2>/dev/null")
for c in ["pip install -q unsloth",
          'pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q torchcodec", "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch; torch._dynamo.config.recompile_limit = 64
from unsloth import FastModel

cands = glob.glob("/kaggle/input/**/adapter_config.json", recursive=True)
assert cands, "adapter_config.json not found under /kaggle/input"
adir = os.path.dirname(cands[0]); print("ADAPTER:", adir, flush=True)
model, tok = FastModel.from_pretrained(adir, dtype=None, max_seq_length=3584, load_in_4bit=True)
FastModel.for_inference(model)
TKZ = getattr(tok, "tokenizer", tok)

TOOLS = [{"type": "function", "function": {"name": n, "description": d, "parameters": p}} for n, d, p in [
    ("argent_list-devices", "List simulators/emulators/Chromium apps.", {"type": "object", "properties": {}}),
    ("argent_boot-device", "Boot a device by udid.", {"type": "object", "properties": {"udid": {"type": "string"}}}),
    ("argent_launch-app", "Launch an app by bundleId / package.", {"type": "object", "properties": {"udid": {"type": "string"}, "bundleId": {"type": "string"}}}),
    ("argent_describe", "Describe the current screen accessibility tree.", {"type": "object", "properties": {"udid": {"type": "string"}}}),
    ("argent_gesture-tap", "Tap at normalized [0,1] coords.", {"type": "object", "properties": {"udid": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}}),
    ("argent_button", "Press a button (home,back,appSwitch,...).", {"type": "object", "properties": {"udid": {"type": "string"}, "button": {"type": "string"}}}),
]]
def gen(messages):
    text = tok.apply_chat_template(messages, tools=TOOLS, add_generation_prompt=True, tokenize=False)
    ids = TKZ(text, return_tensors="pt").to("cuda")
    out = model.generate(**ids, max_new_tokens=80, do_sample=False)
    return TKZ.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=False)

U = "52DE854E-338D-4F8A-8EC9-13854C6EA239"
SYS = "You drive mobile apps via the Argent toolkit."
sc1 = [{"role": "system", "content": SYS}, {"role": "user", "content": "Boot a device and open Settings."},
       {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": "argent_list-devices", "arguments": {}}}]},
       {"role": "tool", "name": "argent_list-devices", "content": json.dumps({"devices": [{"platform": "ios", "udid": U, "name": "iPhone 16 Pro Max", "state": "Shutdown"}]})},
       {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": "argent_boot-device", "arguments": {"udid": U}}}]},
       {"role": "tool", "name": "argent_boot-device", "content": json.dumps({"booted": True, "udid": U})}]
print("=== sc1 (boot -> open Settings) — EXPECT argent_launch-app com.apple.Preferences ===", flush=True)
print(repr(gen(sc1)), flush=True)

sc2 = [{"role": "system", "content": SYS}, {"role": "user", "content": "Open the Settings app."},
       {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": "argent_list-devices", "arguments": {}}}]},
       {"role": "tool", "name": "argent_list-devices", "content": json.dumps({"devices": [{"platform": "ios", "udid": U, "name": "iPhone 16 Pro Max", "state": "Booted"}]})}]
print("=== sc2 (already booted -> open Settings) ===", flush=True)
print(repr(gen(sc2)), flush=True)

# Rigor: the ORIGINAL bug appeared under SAMPLING (temp>0), so prove the fix holds there too.
print("=== sc1 under SAMPLING (temp 0.7) x6 — count com.apple.Preferences ===", flush=True)
ok = 0
for s in range(6):
    torch.manual_seed(s)
    text = tok.apply_chat_template(sc1, tools=TOOLS, add_generation_prompt=True, tokenize=False)
    ids = TKZ(text, return_tensors="pt").to("cuda")
    out = model.generate(**ids, max_new_tokens=60, do_sample=True, temperature=0.7, top_p=0.95, top_k=64)
    txt = TKZ.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=False)
    good = ("argent_launch-app" in txt) and ("com.apple.Preferences" in txt)
    ok += good
    print(f"  seed{s}: {'OK' if good else 'BAD'} -> {txt[:110]!r}", flush=True)
print(f"=== SAMPLING: {ok}/6 correct ===", flush=True)
open("/kaggle/working/EVAL_DONE.txt", "w").write("ok")
print("=== EVAL DONE ===", flush=True)
