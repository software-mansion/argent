# Local packaging step 1: download fp16 base, peft-merge the trained LoRA, save merged HF model,
# and report the key structure (so the text-only rewrite can be written against the real keys).
# Base-agnostic: defaults to the gemma path; for another base set BASE_MODEL (+ MODEL_CLASS=causal_lm
# for a plain text-only LM). MUST match the base the adapter was TRAINED on (see h100_train.py CONFIGS).
import os, json, torch
from transformers import AutoModelForImageTextToText, AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.environ.get("ADAPTER", os.path.join(HERE, "fused/silver-v7-adapter"))
BASE = os.environ.get("BASE_MODEL", "unsloth/gemma-4-E4B-it")   # gemma default (unchanged)
MODEL_CLASS = os.environ.get("MODEL_CLASS", "image_text_to_text")  # or "causal_lm" for a plain text LM
TRUST = os.environ.get("TRUST_REMOTE_CODE", "0") == "1"
MERGED = os.environ.get("MERGED", os.path.join(HERE, "fused/silver-v7-merged"))
_Cls = AutoModelForImageTextToText if MODEL_CLASS == "image_text_to_text" else AutoModelForCausalLM

print(f"=== loading base fp16 ({BASE}, class={MODEL_CLASS}; downloads ~15GB first time) ===", flush=True)
base = _Cls.from_pretrained(BASE, torch_dtype=torch.float16, low_cpu_mem_usage=True, trust_remote_code=TRUST)
print("=== applying adapter + merge_and_unload ===", flush=True)
model = PeftModel.from_pretrained(base, ADAPTER).merge_and_unload()
print("=== saving merged ===", flush=True)
model.save_pretrained(MERGED, safe_serialization=True)
AutoTokenizer.from_pretrained(BASE, trust_remote_code=TRUST).save_pretrained(MERGED)

idx_path = f"{MERGED}/model.safetensors.index.json"
if os.path.exists(idx_path):  # sharded save
    keys = list(json.load(open(idx_path))["weight_map"].keys())
else:  # single-file save (merged model fit under the shard limit) -> read keys from the header
    from safetensors import safe_open
    with safe_open(f"{MERGED}/model.safetensors", framework="pt") as _f:
        keys = list(_f.keys())
print("TOTAL keys:", len(keys), flush=True)
print("first keys:", keys[:4], flush=True)
print("lm_head/embed keys:", [k for k in keys if "lm_head" in k or "embed_tokens" in k][:4], flush=True)
print("language_model keys:", len([k for k in keys if "language_model" in k]), flush=True)
print("vision/audio keys:", len([k for k in keys if "vision" in k or "audio" in k or "multi_modal" in k]), flush=True)
print("=== MERGE DONE ===", flush=True)
