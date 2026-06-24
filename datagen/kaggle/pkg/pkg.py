# Package the trained adapter into a GGUF for ollama on the Mac. Merge adapter+base on the T4 and
# export Q8_0 GGUF (Unsloth-native, reliable, ~8GB; higher quality than q6, trivially bigger). Falls
# back to saving the merged fp16 HF model if the GGUF build fails (then quantize locally).
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, subprocess, torch, glob

assert torch.cuda.get_device_capability(0)[0] >= 7, "need T4"
for c in ["pip install -q unsloth",
          'pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q torchcodec", "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch; torch._dynamo.config.recompile_limit = 64
from unsloth import FastModel

adir = os.path.dirname(glob.glob("/kaggle/input/**/adapter_config.json", recursive=True)[0])
print("ADAPTER:", adir, flush=True)
model, tok = FastModel.from_pretrained(adir, dtype=None, max_seq_length=3584, load_in_4bit=True)

try:
    print("=== exporting Q8_0 GGUF (builds llama.cpp; ~20-30 min) ===", flush=True)
    model.save_pretrained_gguf("/kaggle/working/silver-gguf", tok, quantization_method="q8_0")
    os.system("ls -laR /kaggle/working/silver-gguf 2>/dev/null | tail -20")
    open("/kaggle/working/PKG_OK.txt", "w").write("gguf")
    print("=== PKG OK (gguf q8_0) ===", flush=True)
except Exception as e:
    import traceback; traceback.print_exc()
    print("GGUF export FAILED -> saving merged fp16 HF model instead:", repr(e), flush=True)
    model.save_pretrained_merged("/kaggle/working/merged", tok)
    os.system("ls -la /kaggle/working/merged 2>/dev/null | tail -20")
    open("/kaggle/working/PKG_OK.txt", "w").write("merged")
    print("=== PKG OK (merged fp16) ===", flush=True)
