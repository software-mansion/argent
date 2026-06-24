# Local packaging step 1: download fp16 base, peft-merge the trained LoRA, save merged HF model,
# and report the key structure (so the text-only rewrite can be written against the real keys).
import os, json, torch
from transformers import AutoModelForImageTextToText, AutoTokenizer
from peft import PeftModel

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, "kaggle/train/out/gemma4_lora")
BASE = "unsloth/gemma-4-E4B-it"
MERGED = os.path.join(HERE, "fused/silver-nav-merged")

print("=== loading base fp16 (downloads ~15GB first time) ===", flush=True)
base = AutoModelForImageTextToText.from_pretrained(BASE, torch_dtype=torch.float16, low_cpu_mem_usage=True)
print("=== applying adapter + merge_and_unload ===", flush=True)
model = PeftModel.from_pretrained(base, ADAPTER).merge_and_unload()
print("=== saving merged ===", flush=True)
model.save_pretrained(MERGED, safe_serialization=True)
AutoTokenizer.from_pretrained(BASE).save_pretrained(MERGED)

idx = json.load(open(f"{MERGED}/model.safetensors.index.json"))
keys = list(idx["weight_map"].keys())
print("TOTAL keys:", len(keys), flush=True)
print("first keys:", keys[:4], flush=True)
print("lm_head/embed keys:", [k for k in keys if "lm_head" in k or "embed_tokens" in k][:4], flush=True)
print("language_model keys:", len([k for k in keys if "language_model" in k]), flush=True)
print("vision/audio keys:", len([k for k in keys if "vision" in k or "audio" in k or "multi_modal" in k]), flush=True)
print("=== MERGE DONE ===", flush=True)
