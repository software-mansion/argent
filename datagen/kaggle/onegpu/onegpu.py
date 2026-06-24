# Does ONE 16GB T4 fit gemma-4 QLoRA at 6144 with the two memory tricks from the multi-GPU saga?
#  (1) manual kbit prep -> skip the 10.5GB fp16->fp32 upcast of the 2.6B PLE embeddings
#  (2) custom chunked CE (Liger fused linear CE on hidden states) -> no 262K-vocab logit tensor
# Single device => none of the cross-device split bugs (multimodal merge, RNG fork, tied-weight, loss device).
import os, subprocess
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
print(subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout, flush=True)
for c in ["pip install -q accelerate bitsandbytes datasets peft liger-kernel",
          'pip install -q --no-deps trl==0.22.2 transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    print("+", c, flush=True); os.system(c)

import torch
from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer, SFTConfig
import trl.models.utils as _tmu
_tmu.prepare_model_for_kbit_training = lambda m, *a, **k: m  # we prep manually; skip the blanket fp32 upcast
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets

MODEL = "unsloth/gemma-4-E4B-it"
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.float16)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.float16, attn_implementation="eager", device_map={"": 0})
print("loaded; mem used:", subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader"], capture_output=True, text=True).stdout, flush=True)
model.config.use_cache = False
for p in model.parameters():
    p.requires_grad = False
    if p.dtype in (torch.float16, torch.bfloat16) and p.numel() < 50_000_000:
        p.data = p.data.to(torch.float32)
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
lora = LoraConfig(r=8, lora_alpha=8, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora); model.print_trainable_parameters()
_LCE = LigerFusedLinearCrossEntropyLoss()

class LigerCETrainer(SFTTrainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        m = model.get_base_model() if hasattr(model, "get_base_model") else model
        base = m.model.language_model  # text model, skip multimodal merge
        out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
        hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
        W = base.embed_tokens.weight  # tied to lm_head
        H = hidden.size(-1)
        sh = hidden[:, :-1, :].contiguous().view(-1, H)
        sl = labels[:, 1:].contiguous().view(-1).to(sh.device)
        loss = _LCE(W, sh, sl)
        return (loss, out) if return_outputs else loss

filler = "The quick brown fox jumps over the lazy dog. " * 900
text = tok.apply_chat_template([{"role":"user","content":filler},{"role":"assistant","content":"Acknowledged."}], tokenize=False)
if text.startswith("<bos>"): text = text[5:]
print("dummy tokens ~", len(TKZ(text)["input_ids"]), flush=True)
ds = datasets.Dataset.from_dict({"text": [text] * 16})
trainer = LigerCETrainer(model=model, processing_class=TKZ, train_dataset=ds,
    args=SFTConfig(dataset_text_field="text", max_length=6144, per_device_train_batch_size=1,
        gradient_accumulation_steps=1, max_steps=3, warmup_steps=1, learning_rate=2e-4, logging_steps=1,
        optim="adamw_8bit", gradient_checkpointing=False, fp16=True, bf16=False, report_to="none",
        output_dir="/kaggle/working/out"))
trainer.train()
print("peak GPU MiB:", torch.cuda.max_memory_allocated() // 1024 // 1024, flush=True)
open("/kaggle/working/ONEGPU_OK.txt", "w").write("ok")
print("=== ONEGPU OK (6144 fits on a single 16GB T4) ===", flush=True)
