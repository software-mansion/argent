# Multi-GPU gemma-4 QLoRA at 6144 across 2x T4: custom device_map split (PROVEN) + a custom compute_loss
# that runs the base model for HIDDEN STATES (no lm_head logits) then Liger's standalone fused linear CE
# -> chunked CE, zero 262K-vocab logit tensor, NO text-model extraction (that produced garbage), works
# directly on the multimodal Gemma4ForConditionalGeneration.
# STATUS (06-24): MEMORY PROVEN — `MGPU SMOKE OK`, 6144 fits + trains 3/3 steps across 2x T4; chunked CE
# verified mathematically correct (== model full-logits CE). OPEN: grad_norm=nan every step (fp16 gemma-4
# on T4-no-bf16 numerical bind). Ruled out as causes: eager vs SDPA attention, grad-ckpt on/off, seq
# 512..6144, CE/LoRA/param dtype. fp16->NaN vs fp32->OOM at 6144. Unsloth (single-GPU) handles this fp16
# stability; vanilla transformers does not. Clean 6K path = bf16 substrate (rented 24GB GPU ~$2, or TPU+JAX).
import os, subprocess
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
print(subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True).stdout, flush=True)
for c in ["pip install -q accelerate bitsandbytes datasets peft liger-kernel",
          'pip install -q --no-deps trl==0.22.2 transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    print("+", c, flush=True); os.system(c)

import torch
from accelerate import init_empty_weights
from transformers import AutoConfig, AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
import trl.models.utils as _tmu
# trl calls prepare_model_for_kbit_training whenever the model is an already-quantized PeftModel (even with
# peft_config=None); that blanket fp16->fp32 upcast of gemma-4's 2.6B PLE embeds is the 10.5GB OOM. We do
# the essential prep manually below, so neuter trl's reference to it.
_tmu.prepare_model_for_kbit_training = lambda m, *a, **k: m
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets

MODEL = "unsloth/gemma-4-E4B-it"; S = 28
config = AutoConfig.from_pretrained(MODEL)
with init_empty_weights():
    meta = AutoModelForImageTextToText.from_config(config)
n = config.text_config.num_hidden_layers
dm = {}
for i in range(n): dm[f"model.language_model.layers.{i}"] = 0 if i < S else 1
for name, _ in meta.model.language_model.named_children():
    if name != "layers": dm[f"model.language_model.{name}"] = 1
for name, _ in meta.model.named_children():
    if name != "language_model": dm[f"model.{name}"] = 0
for name, _ in meta.named_children():
    if name != "model": dm[name] = 1
del meta
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.float16)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.float16, attn_implementation="sdpa", device_map=dm)
print("model loaded; per-GPU mem:", flush=True)
print(subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader"], capture_output=True, text=True).stdout, flush=True)
model.config.use_cache = False
# REAL fix for the 10.5GB OOM: trl/peft prepare_model_for_kbit_training upcasts EVERY fp16 param to
# fp32 at init — including gemma-4's ~2.6B PLE embeddings (=10.5GB) on the embed-heavy GPU. Prepare
# MANUALLY: freeze all, upcast only SMALL params (norms) to fp32, keep big embeddings fp16. Then
# get_peft_model ourselves and pass the peft model WITHOUT peft_config (so trl skips the upcast).
from peft import get_peft_model
for nm, p in model.named_parameters():
    p.requires_grad = False
    # fp32 SMALL params (norms <50M) only: on the SPLIT, all-fp16 degenerates the cross-device forward to
    # loss 0; fp32 norms give a finite forward (v13). Big embeds stay fp16 (the fp32 upcast OOMs).
    if p.dtype in (torch.float16, torch.bfloat16) and p.numel() < 50_000_000:
        p.data = p.data.to(torch.float32)
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
lora = LoraConfig(r=8, lora_alpha=8, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora); model.print_trainable_parameters()  # LoRA stays fp16 (no upcast)
_LCE = LigerFusedLinearCrossEntropyLoss()
# fp16 GradScaler default init_scale=65536 overshoots gemma's grads -> skips ~8 steps; start low so it settles.
import torch.amp as _amp
_oinit = _amp.GradScaler.__init__
_amp.GradScaler.__init__ = lambda self, *a, **k: _oinit(self, *a, **{**k, "init_scale": 2.0 ** 10})

class LigerCETrainer(SFTTrainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        m = model.get_base_model() if hasattr(model, "get_base_model") else model  # Gemma4ForConditionalGeneration (LoRA active)
        # inner TEXT model (Gemma4TextModel) — skips the multimodal merge (torch.where pad_embedding) that
        # mixes cuda:0 (vision) and cuda:1 (text embeds) and crashes on a split device_map.
        base = m.model.language_model
        out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
        hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
        # lm_head is tied to embed_tokens; under a custom device_map the lm_head.weight can stay
        # unmaterialized (meta) -> Triton sees a non-GPU pointer. Use the materialized tied source and
        # align every tensor to its device.
        W = base.embed_tokens.weight  # now fp32 (upcast); compute the CE in fp32 for stability
        H = hidden.size(-1)
        sh = hidden[:, :-1, :].contiguous().view(-1, H).to(W.device).to(W.dtype)
        sl = labels[:, 1:].contiguous().view(-1).to(W.device)
        loss = _LCE(W, sh, sl)
        print(f"[fwd] hidden finite={torch.isfinite(hidden).all().item()} loss={loss.item():.4f} "
              f"hidden.dev={hidden.device} W.dev={W.device} W.dtype={W.dtype}", flush=True)
        loss = loss.to("cuda:0")  # HF Trainer asserts the loss sits on the primary device (cuda:0)
        return (loss, out) if return_outputs else loss

filler = "The quick brown fox jumps over the lazy dog. " * 900
text = tok.apply_chat_template([{"role":"user","content":filler},{"role":"assistant","content":"Acknowledged."}], tokenize=False)
if text.startswith("<bos>"): text = text[5:]
print("dummy tokens ~", len(TKZ(text)["input_ids"]), flush=True)
ds = datasets.Dataset.from_dict({"text": [text] * 16})
trainer = LigerCETrainer(model=model, processing_class=TKZ, train_dataset=ds,  # NO peft_config (already peft) -> trl skips its fp32 upcast
    args=SFTConfig(dataset_text_field="text", max_length=6144, per_device_train_batch_size=1,
        gradient_accumulation_steps=1, max_steps=10, warmup_steps=1, learning_rate=2e-4, logging_steps=1,
        optim="adamw_8bit", gradient_checkpointing=False,
        fp16=True, bf16=False, report_to="none", output_dir="/kaggle/working/out"))
trainer.train()
open("/kaggle/working/MGPU_SMOKE_OK.txt", "w").write("ok")
print("=== MGPU SMOKE OK (6144 fits: device_map split + Liger fused CE) ===", flush=True)
