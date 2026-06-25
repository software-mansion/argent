# H100 training kernel for silver 20K nav model. bf16 (no fp16 hacks needed) + all-on-GPU (80GB) +
# the T4-VALIDATED recipe (manual prep + text-only LoRA regex + custom inner-text-model Liger CE) at 20480.
# Data: silver-nav-longctx (10-20K rows, real provider prompts + full catalog). Run on a rented H100:
#   pip install -U transformers==5.5.0 trl==0.22.2 peft bitsandbytes accelerate datasets liger-kernel "tokenizers>=0.22,<=0.23"
#   put train.jsonl under ./data/ (or set DATA_DIR), then: python h100_train.py
# REAL retrain on the PROVEN free recipe (silver-iso): single T4, 6144 seq, verbose 16-tool data.
# Recipe: 4bit + SDPA + all-fp16 (no upcast) + PLE(embed_tokens_per_layer)->CPU + chunked Liger CE +
# grad-ckpt(use_reentrant=False) + GradScaler init_scale=2**10. Trains gemma-4 E4B QLoRA, saves adapter.
import os, json, glob
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
for c in ["pip install -q accelerate bitsandbytes datasets peft liger-kernel",
          'pip install -q --no-deps trl==0.22.2 transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch
from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer, SFTConfig
import trl.models.utils as _tmu
_tmu.prepare_model_for_kbit_training = lambda m, *a, **k: m
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets
MAXLEN = 40960
MODEL = "unsloth/gemma-4-E4B-it"
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.bfloat16)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.bfloat16, attn_implementation="sdpa", device_map={"": 0})  # bf16 + all-on-GPU (80GB)
model.config.use_cache = False
for p in model.parameters():
    p.requires_grad = False  # all-fp16, no upcast (SDPA + GradScaler + fp32-internal RMSNorm = stable)
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
lora = LoraConfig(r=16, lora_alpha=16, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora); model.print_trainable_parameters()
_LCE = LigerFusedLinearCrossEntropyLoss()

class LigerCETrainer(SFTTrainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        m = model.get_base_model() if hasattr(model, "get_base_model") else model
        base = m.model.language_model
        out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
        hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
        W = base.embed_tokens.weight
        sh = hidden[:, :-1, :].contiguous().view(-1, hidden.size(-1)).to(W.dtype)
        sl = labels[:, 1:].contiguous().view(-1).to(sh.device)
        return _LCE(W, sh, sl)

def _find(split):
    import os as _os
    root = _os.environ.get("DATA_DIR", "/kaggle/input")
    c = glob.glob(f"{root}/**/{split}.jsonl", recursive=True)
    if not c: raise FileNotFoundError(f"{split}.jsonl not under /kaggle/input")
    return c[0]
def to_text(split):
    out = []
    for line in open(_find(split)):
        d = json.loads(line)
        t = tok.apply_chat_template(d["messages"], tools=d.get("tools"), tokenize=False)
        if t.startswith("<bos>"): t = t[5:]
        out.append(t)  # rows are <=38K <= MAXLEN by construction; SFTTrainer truncates any rare over -> skip the costly pre-filter tokenize
    print(f"{split}: {len(out)} rows", flush=True)
    return datasets.Dataset.from_dict({"text": out})

train_ds = to_text("train")
trainer = LigerCETrainer(model=model, processing_class=TKZ, train_dataset=train_ds,
    args=SFTConfig(dataset_text_field="text", max_length=MAXLEN, per_device_train_batch_size=1,
        gradient_accumulation_steps=4, max_steps=300, warmup_steps=10, learning_rate=2e-4,
        logging_steps=5, save_steps=10_000, optim="adamw_8bit", gradient_checkpointing=False,
        fp16=False, bf16=True, lr_scheduler_type="cosine", report_to="none", output_dir="./out"))
trainer.train()
model.save_pretrained("./adapter")
tok.save_pretrained("./adapter")
open("./TRAIN_OK.txt", "w").write("ok")
print("=== TRAIN_OK — adapter saved to /kaggle/working/adapter ===", flush=True)
