# H100 training kernel for the silver long-context nav model. bf16 + all-on-GPU (80GB).
# Recipe = the T4-PROVEN silver-iso recipe (loss 13.06->0.93, 0 NaN grads, 10.6GB peak) transposed to
# bf16, which DROPS every fp16 hack the T4 needed: no GradScaler/init_scale, no PLE->CPU offload, no
# fp32-upcast worries (bf16 has fp32's exponent range). What carries over from iso: 4-bit base, text-only
# LoRA regex, custom Liger CE on the INNER text model (avoids the 262K-vocab logit OOM), grad-ckpt
# (use_reentrant=False), attn=sdpa.
#
# WHAT'S NEW vs the iso/text-field recipe (verified locally on all 3272 rows before this paid run):
#   • COMPLETION-ONLY LOSS. The data is ~34K tokens/row of which only ~1% is assistant tool-calls/summary
#     (p50 1.02%). Full-sequence loss would spend 99% of the gradient reconstructing the static harness
#     prompt+catalog. We pre-tokenize and mask everything except assistant-generated spans (the
#     <|tool_call>..<tool_call|> blocks + final summary text + the closing <turn|>), EXCLUDING the
#     <|tool_response>..<tool_response|> environment outputs. Mask proven correct: every tool-call name &
#     summary labeled, zero tool-result/system leakage, zero empty masks across the full dataset.
#   • plain transformers.Trainer (not SFTTrainer) since we feed pre-tokenized {input_ids,labels}.
#   • real checkpointing (save_steps=50), full-epoch budget, data-existence check BEFORE the model load.
#
# Run on a rented 80GB H100 (recent PyTorch base image, torch>=2.4):
#   put train.jsonl under ./data/  (or set DATA_DIR=/path), then:  python h100_train.py
#   optional env: EPOCHS (default 3), DATA_DIR, OUT_DIR (default ./adapter)
import os, json, glob, re, sys
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

def sh(cmd):
    print(">>", cmd, flush=True)
    if os.system(cmd) != 0:
        raise SystemExit(f"FATAL: dependency install failed (exit!=0): {cmd}")
# core deps WITH their own deps (so a non-Kaggle base image isn't left with missing transitive packages);
# then pin transformers/tokenizers on top with --no-deps so the box's torch is left untouched.
sh("pip install -q accelerate bitsandbytes datasets peft liger-kernel")
sh('pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"')
sh("pip install -q --no-deps --upgrade timm")
# Gemma 3n E4B attention is mixed: 35 sliding-window layers (head_dim 256, flash-attn handles them) + 7
# full-attention layers (head_dim 512, which flash-attn REJECTS — its cap is 256). The hybrid attention
# below routes the 512-dim layers through xformers (cutlass, head_dim<=512, O(L) memory). Both kernels are
# required; without them SDPA falls back to the math backend and OOMs at >~10K tokens. (flash-attn wheel is
# pinned for torch2.6/cu124/py311/abiFALSE — swap it to match a different torch/python.)
def _ensure(mod, install):
    try: __import__(mod)
    except Exception: sh(install)
_ensure("flash_attn", 'pip install -q --no-deps einops '
        '"https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/'
        'flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl"')
_ensure("xformers", "pip install -q --no-deps xformers==0.0.29.post3")

import torch
from transformers import (AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig,
                          Trainer, TrainingArguments)
from peft import LoraConfig, get_peft_model
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets, transformers, peft, bitsandbytes
print(f"versions: torch={torch.__version__} transformers={transformers.__version__} "
      f"peft={peft.__version__} bnb={bitsandbytes.__version__}", flush=True)

# ---- hybrid attention (verified numerically exact vs eager: max|Δ|~0.01 at bf16 noise) ----
# Registered under "flash_attention_2", so the model's 35 head_dim-256 layers keep transformers' proven
# flash path (incl. sliding-window handling) and only the 7 head_dim-512 full-attention layers divert to
# xformers. Inputs are heads-first [B, H, L, D]; xformers wants [B, L, H, D] and KV expanded for GQA.
from transformers import AttentionInterface
from transformers.integrations.flash_attention import flash_attention_forward as _orig_flash
import xformers.ops as _xops
def _hybrid_attn(module, query, key, value, attention_mask, scaling=None, dropout=0.0, **kw):
    if query.shape[-1] <= 256:
        return _orig_flash(module, query, key, value, attention_mask, scaling=scaling, dropout=dropout, **kw)
    Hq, Hkv = query.shape[1], key.shape[1]
    q = query.transpose(1, 2); k = key.transpose(1, 2); v = value.transpose(1, 2)
    if Hkv != Hq:
        r = Hq // Hkv; k = k.repeat_interleave(r, dim=2); v = v.repeat_interleave(r, dim=2)
    o = _xops.memory_efficient_attention(q.contiguous(), k.contiguous(), v.contiguous(),
                                         attn_bias=_xops.LowerTriangularMask(), scale=scaling)
    return o, None
AttentionInterface.register("flash_attention_2", _hybrid_attn)
assert torch.cuda.is_available(), "FATAL: no CUDA device"

MAXLEN  = 40960
MODEL   = "unsloth/gemma-4-E4B-it"
EPOCHS  = float(os.environ.get("EPOCHS", "2"))  # v6 worked at ~600 seqs; 2 epochs = ~6.5k seqs w/ focused mask
MAX_STEPS = int(os.environ.get("MAX_STEPS", "-1"))  # >0 caps total optim steps (overrides EPOCHS) for a bounded run
OUT_DIR = os.environ.get("OUT_DIR", "./adapter")

# ---- data discovery FIRST (fail fast, before the multi-minute 8B model download/quantize) ----
def _find(split):
    root = os.environ.get("DATA_DIR", "./data")
    c = glob.glob(f"{root}/**/{split}.jsonl", recursive=True) or glob.glob(f"/kaggle/input/**/{split}.jsonl", recursive=True)
    if not c:
        raise FileNotFoundError(f"{split}.jsonl not found under DATA_DIR={root!r} (or /kaggle/input). "
                                f"Put train.jsonl there or set DATA_DIR.")
    return c[0]
TRAIN_PATH = _find("train")
print(f"data: {TRAIN_PATH}", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
PAD = tok.pad_token_id if tok.pad_token_id is not None else 0

# ---- completion-only label mask (verified on all 3272 rows; see test_mask.py) ----
# A model block runs "<|turn>model\n" .. next "<turn|>" OR end-of-text (trajectories ending on a tool
# result leave the final block unclosed but still hold labelable tool_calls). Assistant-generated =
# model-block content minus the <|tool_response>..<tool_response|> spans.
MODEL_BLOCK = re.compile(r"<\|turn>model\n(.*?)(?:<turn\|>|\Z)", re.DOTALL)
TOOL_RESP   = re.compile(r"<\|tool_response>.*?<tool_response\|>", re.DOTALL)

def _assistant_spans(txt):
    spans = []
    for mt in MODEL_BLOCK.finditer(txt):
        bstart, block = mt.start(1), mt.group(1)
        last = 0
        for tr in TOOL_RESP.finditer(block):
            if tr.start() > last:
                spans.append((bstart + last, bstart + tr.start()))
            last = tr.end()
        if last < len(block):
            spans.append((bstart + last, bstart + len(block)))
        if mt.group(0).endswith("<turn|>"):
            spans.append((mt.end(1), mt.end()))  # the closing <turn|> -> learn to stop
    return spans

def build_example(messages, tools):
    txt = tok.apply_chat_template(messages, tools=tools, tokenize=False)
    enc = tok(txt, add_special_tokens=False, return_offsets_mapping=True)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    spans = _assistant_spans(txt)
    labels = [-100] * len(ids)
    for k, (a, b) in enumerate(offs):
        if a == b:  # zero-width = a special token; label it if it sits inside an assistant span
            if any(s <= a < e for (s, e) in spans):
                labels[k] = ids[k]
            continue
        if any(s <= a and b <= e for (s, e) in spans):
            labels[k] = ids[k]
    return ids, labels

def load(split):
    rows, ntok, nlab, skipped, over = [], 0, 0, 0, 0
    for line in open(_find(split)):
        d = json.loads(line)
        ids, labels = build_example(d["messages"], d.get("tools"))
        if len(ids) > MAXLEN:  # proven 0 across the dataset; guard anyway (right-trunc would drop the answer)
            over += 1; ids, labels = ids[:MAXLEN], labels[:MAXLEN]
        if not any(l != -100 for l in labels):
            skipped += 1; continue  # never observed, but a dead row would only add cost
        rows.append({"input_ids": ids, "labels": labels})
        ntok += len(ids); nlab += sum(1 for l in labels if l != -100)
    print(f"{split}: {len(rows)} rows | labeled {nlab}/{ntok} = {100*nlab/max(ntok,1):.2f}% "
          f"| skipped_empty={skipped} truncated={over}", flush=True)
    return datasets.Dataset.from_list(rows)

train_ds = load("train")

def collate(batch):
    m = max(len(b["input_ids"]) for b in batch)
    iid = [b["input_ids"] + [PAD]   * (m - len(b["input_ids"])) for b in batch]
    lab = [b["labels"]    + [-100]  * (m - len(b["labels"]))    for b in batch]
    att = [[1] * len(b["input_ids"]) + [0] * (m - len(b["input_ids"])) for b in batch]
    return {"input_ids": torch.tensor(iid), "labels": torch.tensor(lab), "attention_mask": torch.tensor(att)}

# ---- model: bf16, 4-bit base, everything on the 80GB GPU ----
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.bfloat16)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.bfloat16, attn_implementation="flash_attention_2", device_map={"": 0})
model.config.use_cache = False
for p in model.parameters():
    p.requires_grad = False  # base frozen; LoRA adapters (created below) are the only trainable params
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
lora = LoraConfig(r=16, lora_alpha=16, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora); model.print_trainable_parameters()
_LCE = LigerFusedLinearCrossEntropyLoss()  # ignore_index=-100 -> masked (prompt/tool-result) tokens skipped

class LigerCETrainer(Trainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        m = model.get_base_model() if hasattr(model, "get_base_model") else model
        base = m.model.language_model
        out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
        hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
        W = base.embed_tokens.weight
        sh = hidden[:, :-1, :].contiguous().view(-1, hidden.size(-1)).to(W.dtype)
        sl = labels[:, 1:].contiguous().view(-1).to(sh.device)  # shift: position i predicts token i+1
        return _LCE(W, sh, sl)

steps_per_epoch = max(1, len(train_ds) // 4)
print(f"plan: {EPOCHS} epochs x ~{steps_per_epoch} optim steps = ~{int(EPOCHS*steps_per_epoch)} steps "
      f"(bs1 x grad_accum4)", flush=True)
trainer = LigerCETrainer(
    model=model, processing_class=TKZ, train_dataset=train_ds, data_collator=collate,
    args=TrainingArguments(
        per_device_train_batch_size=1, gradient_accumulation_steps=4, num_train_epochs=EPOCHS, max_steps=MAX_STEPS,
        warmup_ratio=0.03, learning_rate=2e-4, logging_steps=5, save_steps=50, save_total_limit=2,
        optim="adamw_8bit", gradient_checkpointing=False, fp16=False, bf16=True,
        lr_scheduler_type="cosine", report_to="none", remove_unused_columns=False, output_dir="./out"))
trainer.train()
model.save_pretrained(OUT_DIR)
tok.save_pretrained(OUT_DIR)
open("./TRAIN_OK.txt", "w").write("ok")
print(f"=== TRAIN_OK — adapter saved to {os.path.abspath(OUT_DIR)} ===", flush=True)
