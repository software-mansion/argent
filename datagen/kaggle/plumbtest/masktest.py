# PLUMBING TEST for the H100 recipe's NEW pieces, on a FREE T4. Isolates exactly what h100_train.py
# changed vs the proven silver-iso run: (1) completion-only MASKING loader, (2) transformers.Trainer
# (not SFTTrainer) fed PRE-TOKENIZED {input_ids,labels}, (3) the custom pad collator, (4) the custom
# inner-text-model Liger CE consuming -100-masked labels. Everything ELSE is the iso T4-proven fp16
# substrate (fp16 + PLE->CPU + GradScaler init_scale=2**10 + SDPA), so any failure here is the NEW code,
# not the dtype. Data: silver-masktest (96 short verbose rows <=5500 tok, fit T4 at 6144).
# PASS = loss decreases + hidden finite + valid_labels ratio ~1-15% (masking LIVE, not 100%) + 0 NaN grads.
import os, json, glob, re, traceback
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
for c in ["pip install -q accelerate bitsandbytes datasets peft liger-kernel",
          'pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch
from transformers import (AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig,
                          Trainer, TrainingArguments)
from peft import LoraConfig, get_peft_model
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets
MAXLEN = 6144
MODEL = "unsloth/gemma-4-E4B-it"
# iso fp16 T4 substrate (PROVEN: loss 13->0.93, 0 NaN grads, 10.6GB peak)
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.float16, llm_int8_enable_fp32_cpu_offload=True)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.float16, attn_implementation="sdpa",
    device_map={"model.language_model.embed_tokens_per_layer": "cpu", "": 0})
model.config.use_cache = False
for p in model.parameters():
    p.requires_grad = False
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
PAD = tok.pad_token_id if tok.pad_token_id is not None else 0
lora = LoraConfig(r=16, lora_alpha=16, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora); model.print_trainable_parameters()
_LCE = LigerFusedLinearCrossEntropyLoss()
import torch.amp as _amp  # fp16 GradScaler overshoots init=65536 on gemma -> start low (iso fix)
_oinit = _amp.GradScaler.__init__
_amp.GradScaler.__init__ = lambda self, *a, **k: _oinit(self, *a, **{**k, "init_scale": 2.0 ** 10})

# ---- NEW pieces under test: masker + loader + collator + Trainer + compute_loss ----
MODEL_BLOCK = re.compile(r"<\|turn>model\n(.*?)(?:<turn\|>|\Z)", re.DOTALL)
TOOL_RESP   = re.compile(r"<\|tool_response>.*?<tool_response\|>", re.DOTALL)
def _spans(txt):
    s = []
    for mt in MODEL_BLOCK.finditer(txt):
        bs, bl = mt.start(1), mt.group(1); last = 0
        for tr in TOOL_RESP.finditer(bl):
            if tr.start() > last: s.append((bs+last, bs+tr.start()))
            last = tr.end()
        if last < len(bl): s.append((bs+last, bs+len(bl)))
        if mt.group(0).endswith("<turn|>"): s.append((mt.end(1), mt.end()))
    return s
def build_example(messages, tools):
    txt = tok.apply_chat_template(messages, tools=tools, tokenize=False)
    enc = tok(txt, add_special_tokens=False, return_offsets_mapping=True)
    ids, offs = enc["input_ids"], enc["offset_mapping"]; sp = _spans(txt)
    lab = [-100]*len(ids)
    for k, (a, b) in enumerate(offs):
        if a == b:
            if any(s <= a < e for s, e in sp): lab[k] = ids[k]
        elif any(s <= a and b <= e for s, e in sp): lab[k] = ids[k]
    return ids, lab
def _find(split):
    c = glob.glob(f"/kaggle/input/**/{split}.jsonl", recursive=True)
    if not c: raise FileNotFoundError(split)
    return c[0]
def load(split):
    rows, ntok, nlab, sk = [], 0, 0, 0
    for line in open(_find(split)):
        line = line.strip()
        if not line: continue
        d = json.loads(line); ids, lab = build_example(d["messages"], d.get("tools"))
        if len(ids) > MAXLEN: ids, lab = ids[:MAXLEN], lab[:MAXLEN]
        if not any(l != -100 for l in lab): sk += 1; continue
        rows.append({"input_ids": ids, "labels": lab}); ntok += len(ids); nlab += sum(1 for l in lab if l != -100)
    print(f"{split}: {len(rows)} rows | labeled {nlab}/{ntok}={100*nlab/max(ntok,1):.2f}% | skipped={sk}", flush=True)
    return datasets.Dataset.from_list(rows)
def collate(batch):
    m = max(len(b["input_ids"]) for b in batch)
    iid = [b["input_ids"] + [PAD]*(m-len(b["input_ids"])) for b in batch]
    lab = [b["labels"]    + [-100]*(m-len(b["labels"]))    for b in batch]
    att = [[1]*len(b["input_ids"]) + [0]*(m-len(b["input_ids"])) for b in batch]
    return {"input_ids": torch.tensor(iid), "labels": torch.tensor(lab), "attention_mask": torch.tensor(att)}

class LigerCETrainer(Trainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        m = model.get_base_model() if hasattr(model, "get_base_model") else model
        base = m.model.language_model
        out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
        hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
        W = base.embed_tokens.weight
        sh = hidden[:, :-1, :].contiguous().view(-1, hidden.size(-1)).to(W.dtype)
        sl = labels[:, 1:].contiguous().view(-1).to(sh.device)
        loss = _LCE(W, sh, sl)
        nv = (sl != -100).sum().item(); tot = sl.numel()
        print(f"[fwd] hidden_finite={torch.isfinite(hidden).all().item()} loss={loss.item():.4f} "
              f"valid_labels={nv}/{tot} ({100*nv/max(tot,1):.2f}%)", flush=True)
        return loss

train_ds = load("train")
trainer = LigerCETrainer(model=model, processing_class=TKZ, train_dataset=train_ds, data_collator=collate,
    args=TrainingArguments(per_device_train_batch_size=1, gradient_accumulation_steps=2, max_steps=16,
        warmup_steps=2, learning_rate=2e-4, logging_steps=1, save_steps=10_000, optim="adamw_8bit",
        gradient_checkpointing=False, fp16=True, bf16=False, lr_scheduler_type="cosine",
        report_to="none", remove_unused_columns=False, output_dir="/kaggle/working/out"))
try:
    trainer.train()
    bad = [n for n, p in model.named_parameters() if p.requires_grad and p.grad is not None and not torch.isfinite(p.grad).all()]
    print("NaN/inf-grad params:", len(bad), bad[:6], flush=True)
    print("peak GPU MiB:", torch.cuda.max_memory_allocated()//1024//1024, flush=True)
    open("/kaggle/working/PLUMB_OK.txt", "w").write("ok")
    print("=== PLUMB_OK — new masked Trainer pipeline trains FINITE on real GPU ===", flush=True)
except Exception:
    print("=== PLUMB FAIL ===", flush=True); traceback.print_exc()
