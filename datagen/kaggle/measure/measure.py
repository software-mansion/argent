# Measure the SEQ->peak-GPU-memory curve at batch=1 on one T4 (iso recipe), find the OOM ceiling,
# then test whether 40K fits with activation offloading (save_on_cpu). Decides free-40K feasibility.
import os, contextlib
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
for c in ["pip install -q accelerate bitsandbytes peft liger-kernel",
          'pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch
from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
MODEL = "unsloth/gemma-4-E4B-it"
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.float16, llm_int8_enable_fp32_cpu_offload=True)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.float16, attn_implementation="sdpa",
    device_map={"model.language_model.embed_tokens_per_layer": "cpu", "": 0})
model.config.use_cache = False
for p in model.parameters(): p.requires_grad = False
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
lora = LoraConfig(r=16, lora_alpha=16, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora)
_LCE = LigerFusedLinearCrossEntropyLoss()
m = model.get_base_model() if hasattr(model, "get_base_model") else model
base = m.model.language_model
import time
def step(S):
    torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()
    ids = torch.randint(0, 200000, (1, S), device="cuda:0")
    t0 = time.time()
    with torch.autocast("cuda", dtype=torch.float16):
        out = base(input_ids=ids, use_cache=False)
        h = out.last_hidden_state; W = base.embed_tokens.weight
        sh = h[:, :-1, :].reshape(-1, h.size(-1)).to(W.dtype)
        loss = _LCE(W, sh, ids[:, 1:].reshape(-1))
    loss.backward(); model.zero_grad(set_to_none=True)
    return torch.cuda.max_memory_allocated() // 1024 // 1024, time.time() - t0
print("=== SEQ -> peak MiB @ batch1, autocast fp16 (real trainer path) ===", flush=True)
for S in [6144, 10240, 12288, 14336, 16384, 18432, 20480, 24576]:
    try:
        mem, dt = step(S); print(f"  seq={S:6d}: peak {mem:6d} MiB  ({dt:.1f}s)  {'OK' if mem<14500 else 'NEAR-LIMIT'}", flush=True)
    except Exception as e:
        print(f"  seq={S:6d}: {type(e).__name__} -> single-T4 ceiling is just below {S}", flush=True); break
print("=== MEASURE DONE ===", flush=True)
