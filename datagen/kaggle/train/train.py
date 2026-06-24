# Real run v1: QLoRA fine-tune Gemma 4 E4B on the rich nav dataset (silver-nav-rich), then
# evaluate IN-KERNEL on the exact prod failure (boot -> open Settings) so the log shows whether the
# rich data fixed the wrong-bundle-id bug. Bounded max_steps so it finishes inside the session.
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"  # reduce fragmentation OOM on T4
import json, subprocess, torch

print("=== GPU ===", flush=True)
print(subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                     capture_output=True, text=True).stdout, flush=True)
assert torch.cuda.is_available(), "no GPU"
cc = torch.cuda.get_device_capability(0)
print(f"GPU={torch.cuda.get_device_name(0)} CC={cc[0]}.{cc[1]}", flush=True)
if cc[0] < 7:
    open("/kaggle/working/WRONG_GPU.txt", "w").write("need T4"); raise SystemExit("WRONG GPU (need T4)")

os.system("echo '=== /kaggle/input ==='; ls -la /kaggle/input 2>&1; find /kaggle/input -maxdepth 4 -name '*.jsonl' 2>/dev/null")

for c in ["pip install -q unsloth",
          'pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q torchcodec",
          "pip install -q --no-deps --upgrade timm"]:
    print("+", c, flush=True); os.system(c)

import torch; torch._dynamo.config.recompile_limit = 64
from unsloth import FastModel
import datasets

MAXLEN = 3584  # T4 backward ceiling for 7.5B QLoRA: 4608 & 6144 both OOM; 3584 extrapolates to
               # ~14.3GB (fits, ~300MB margin) and keeps ~64% of the medium (compact-desc) rows.
model, tok = FastModel.from_pretrained("unsloth/gemma-4-E4B-it", dtype=None, max_seq_length=MAXLEN,
                                       load_in_4bit=True, full_finetuning=False)
print("=== MODEL LOADED ===", flush=True)
model = FastModel.get_peft_model(model, finetune_vision_layers=False, finetune_language_layers=True,
                                 finetune_attention_modules=True, finetune_mlp_modules=True,
                                 r=8, lora_alpha=8, lora_dropout=0, bias="none", random_state=3407,
                                 use_gradient_checkpointing="unsloth")  # KEY: fits 8192 seq on a 14.5GB T4

import glob
def _find(split):
    c = glob.glob(f"/kaggle/input/**/{split}.jsonl", recursive=True)
    if not c:
        os.system("ls -laR /kaggle/input 2>&1 | head -60")
        raise FileNotFoundError(f"{split}.jsonl not found under /kaggle/input")
    print("loading", c[0], flush=True); return c[0]

def to_text(split):
    out = []; skipped = 0
    for line in open(_find(split)):
        line = line.strip()
        if not line: continue
        d = json.loads(line)
        t = tok.apply_chat_template(d["messages"], tools=d.get("tools"), tokenize=False)
        if t.startswith("<bos>"): t = t[len("<bos>"):]   # SFTTrainer re-adds bos
        if len(getattr(tok, "tokenizer", tok)(t, add_special_tokens=False)["input_ids"]) > MAXLEN:
            skipped += 1; continue   # drop (don't truncate); tok is the multimodal processor -> use .tokenizer
        out.append({"text": t})
    print(f"{split}: kept {len(out)} skipped {skipped} (> {MAXLEN} tok)", flush=True)
    return datasets.Dataset.from_list(out)

train_ds = to_text("train"); valid_ds = to_text("valid")
print(f"train={len(train_ds)} valid={len(valid_ds)}", flush=True)

from trl import SFTTrainer, SFTConfig
trainer = SFTTrainer(
    model=model, tokenizer=tok, train_dataset=train_ds,
    # NO periodic eval: gemma-4's ~262K vocab makes eval materialize full logits (~6.7GB) -> OOM,
    # even though training fits. Final generation eval below is the real signal (80 tokens only).
    args=SFTConfig(dataset_text_field="text", max_seq_length=MAXLEN,
                   per_device_train_batch_size=1, gradient_accumulation_steps=4,
                   warmup_steps=20, max_steps=200, learning_rate=2e-4, logging_steps=10,
                   optim="adamw_8bit", weight_decay=0.001, lr_scheduler_type="linear", seed=3407,
                   report_to="none", output_dir="/kaggle/working/out", save_steps=200,
                   eval_strategy="no", fp16=True, bf16=False),
)
stats = trainer.train()
print("=== TRAIN DONE ===", json.dumps(stats.metrics), flush=True)
model.save_pretrained("/kaggle/working/gemma4_lora"); tok.save_pretrained("/kaggle/working/gemma4_lora")
with open("/kaggle/working/TRAIN_OK.txt", "w") as f:
    f.write(json.dumps(stats.metrics))
print("=== TRAIN_OK (adapter saved) ===", flush=True)

# ===== in-kernel eval on the exact prod failure (best-effort; adapter already saved) =====
try:
    FastModel.for_inference(model)
    TKZ = getattr(tok, "tokenizer", tok)
    TOOLS = [
        {"type": "function", "function": {"name": n, "description": d, "parameters": p}}
        for n, d, p in [
            ("argent_list-devices", "List simulators/emulators/Chromium apps.", {"type": "object", "properties": {}}),
            ("argent_boot-device", "Boot a device by udid.", {"type": "object", "properties": {"udid": {"type": "string"}}}),
            ("argent_launch-app", "Launch an app by bundleId. Common iOS bundle ids: com.apple.Preferences (Settings), com.apple.mobilesafari.", {"type": "object", "properties": {"udid": {"type": "string"}, "bundleId": {"type": "string"}}}),
            ("argent_describe", "Describe the current screen accessibility tree.", {"type": "object", "properties": {"udid": {"type": "string"}}}),
            ("argent_gesture-tap", "Tap at normalized [0,1] coords.", {"type": "object", "properties": {"udid": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}}),
            ("argent_button", "Press a button (home,back,appSwitch,...).", {"type": "object", "properties": {"udid": {"type": "string"}, "button": {"type": "string"}}}),
        ]
    ]
    def gen(messages):
        inp = tok.apply_chat_template(messages, tools=TOOLS, add_generation_prompt=True, tokenize=True,
                                      return_dict=True, return_tensors="pt").to("cuda")
        out = model.generate(**inp, max_new_tokens=80, do_sample=False)
        return TKZ.decode(out[0][inp["input_ids"].shape[1]:], skip_special_tokens=False)
    U = "52DE854E-338D-4F8A-8EC9-13854C6EA239"
    sc1 = [
        {"role": "system", "content": "You drive mobile apps via the Argent toolkit."},
        {"role": "user", "content": "Boot a device and open Settings."},
        {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": "argent_list-devices", "arguments": {}}}]},
        {"role": "tool", "name": "argent_list-devices", "content": json.dumps({"devices": [{"platform": "ios", "udid": U, "name": "iPhone 16 Pro Max", "state": "Shutdown"}]})},
        {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": "argent_boot-device", "arguments": {"udid": U}}}]},
        {"role": "tool", "name": "argent_boot-device", "content": json.dumps({"booted": True, "udid": U})},
    ]
    print("=== EVAL sc1: open Settings -> EXPECT launch-app com.apple.Preferences ===", flush=True)
    print(repr(gen(sc1)), flush=True)
except Exception as e:
    import traceback; print("EVAL FAILED (adapter still saved):", repr(e), flush=True); traceback.print_exc()
print("=== DONE ===", flush=True)
