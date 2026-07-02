# Training kernel for Argent long-context nav LoRAs. bf16 + all-on-GPU (80GB A100/H100).
# Recipe = the T4-PROVEN silver-iso recipe transposed to bf16 (drops the fp16 hacks: no GradScaler,
# no PLE->CPU offload). Carries over: 4-bit base, LoRA on text layers only, custom Liger fused-linear-CE
# (avoids the big-vocab logit OOM at long context), grad-ckpt (use_reentrant=False).
#
# COMPLETION-ONLY LOSS: each ~47k-token row is ~99% static harness (system prompt + tool catalog +
# environment tool_responses). We pre-tokenize and label ONLY assistant-generated spans (the tool_call
# blocks + final summary + the closing turn marker), EXCLUDING tool_response (environment) output.
# Plain transformers.Trainer over pre-tokenized {input_ids,labels}. Real checkpointing (save_steps=50),
# data-existence check BEFORE the multi-minute model download.
#
# ============================ TWO BASE-MODEL PATHS (see TRAINING_PATHS.md) ============================
# The training DATA (.jsonl of raw {messages, tools}) is base-agnostic — each base's own chat template
# renders it at load time. Only these differ per base and are captured in CONFIGS below:
#   • model_id / model_class (multimodal ImageTextToText vs plain CausalLM)
#   • attention (gemma3n needs a flash+xformers HYBRID for its 512-head-dim layers; a standard LM does not)
#   • LoRA target regex (gemma3n hides the text LM under `language_model.`; a standard LM does not)
#   • the loss module path (where the inner decoder + unembedding weight live)
#   • the chat-template MARKERS the completion-only mask keys off (turn/tool_call/tool_response delimiters)
# Select with env `BASE=gemma` (default, the proven silver path) or `BASE=ornith`. Adding a third base =
# add one CONFIGS entry. The gemma entry is byte-for-byte the values the silver v5..v10 runs used — do not
# edit it; it is the control.
# =====================================================================================================
import os, json, glob, re, sys
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

BASE = os.environ.get("BASE", "gemma").lower()

CONFIGS = {
    # ---- GEMMA (silver v5..v10 control — DO NOT EDIT; these are the exact proven values) ----
    "gemma": {
        "model_id": "unsloth/gemma-4-E4B-it",
        "model_class": "image_text_to_text",   # gemma3n is multimodal; the text LM is an inner submodule
        "trust_remote_code": False,
        "hybrid_attn": True,                    # 35 sliding (head_dim 256, flash) + 7 full (head_dim 512, xformers)
        "needs_xformers": True,
        "attn_impl": "flash_attention_2",
        "lora_targets": r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$",
        "loss_mode": "liger_inner_text",        # hidden = m.model.language_model(...); W = its embed_tokens
        # completion-only mask markers (verbatim gemma4 template delimiters — see test_mask.py)
        "model_block_re": r"<\|turn>model\n(.*?)(?:<turn\|>|\Z)",
        "tool_resp_re":   r"<\|tool_response>.*?<tool_response\|>",
        "turn_re":        r"(<\|turn>model\n)(.*?)(<turn\|>|\Z)",
        "turn_close":     "<turn|>",
        "toolresp_close": "<tool_response|>",
        "toolcall_close": "<tool_call|>",
    },
    # ---- ORNITH (9B dense, text-only) — EXPERIMENTAL. Fill the *_ENV knobs from the real model before a
    #      paid run (TRAINING_PATHS.md has the 15-min discovery recipe). Defaults assume a Llama/Qwen/
    #      Mistral-family arch (m.model = decoder, m.lm_head = unembedding, standard proj names). ----
    "ornith": {
        # REQUIRED: the fp16/bf16 HF safetensors repo (NOT the q4_K_M GGUF — QLoRA re-quantizes at load).
        "model_id": os.environ.get("BASE_MODEL", "").strip(),
        "model_class": "causal_lm",
        "trust_remote_code": os.environ.get("TRUST_REMOTE_CODE", "0") == "1",
        "hybrid_attn": False,                   # standard arch -> transformers' real flash_attention_2
        "needs_xformers": False,
        "attn_impl": os.environ.get("ATTN_IMPL", "flash_attention_2"),
        "lora_targets": os.environ.get("LORA_TARGETS",
                        r".*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$"),
        "loss_mode": "liger_causal",            # hidden = m.model(...); W = m.lm_head.weight
        # REQUIRED: ornith's chat-template delimiters. These MUST match what ornith's tokenizer emits, or
        # the mask is empty and every row is skipped. Discover with: BASE=ornith DISCOVER=1 python h100_train.py
        "model_block_re": os.environ.get("MASK_MODEL_BLOCK_RE", ""),
        "tool_resp_re":   os.environ.get("MASK_TOOL_RESP_RE", ""),
        "turn_re":        os.environ.get("MASK_TURN_RE", ""),
        "turn_close":     os.environ.get("MASK_TURN_CLOSE", ""),
        "toolresp_close": os.environ.get("MASK_TOOLRESP_CLOSE", ""),
        "toolcall_close": os.environ.get("MASK_TOOLCALL_CLOSE", ""),
    },
}
if BASE not in CONFIGS:
    raise SystemExit(f"FATAL: unknown BASE={BASE!r}; choose one of {list(CONFIGS)}")
CFG = CONFIGS[BASE]
print(f"BASE={BASE} model_id={CFG['model_id']!r} class={CFG['model_class']} "
      f"hybrid_attn={CFG['hybrid_attn']} loss={CFG['loss_mode']}", flush=True)

def sh(cmd):
    print(">>", cmd, flush=True)
    if os.system(cmd) != 0:
        raise SystemExit(f"FATAL: dependency install failed (exit!=0): {cmd}")
# core deps WITH their own deps; then pin transformers/tokenizers --no-deps so the box's torch is untouched.
sh("pip install -q accelerate bitsandbytes datasets peft liger-kernel")
sh('pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"')
sh("pip install -q --no-deps --upgrade timm")
def _ensure(mod, install):
    try: __import__(mod)
    except Exception: sh(install)
# flash-attn (torch2.6/cu124/py311/abiFALSE wheel) — used by BOTH paths. Swap the wheel to match a
# different torch/python. See TRAINING_PATHS.md / silver_train_env_pins for the pinning traps.
_ensure("flash_attn", 'pip install -q --no-deps einops '
        '"https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/'
        'flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp311-cp311-linux_x86_64.whl"')
if CFG["needs_xformers"]:  # only the gemma3n hybrid needs the cutlass head_dim<=512 kernel
    _ensure("xformers", "pip install -q --no-deps xformers==0.0.29.post3")

import torch
from transformers import AutoTokenizer, BitsAndBytesConfig, Trainer, TrainingArguments
if CFG["model_class"] == "image_text_to_text":
    from transformers import AutoModelForImageTextToText as ModelClass
else:
    from transformers import AutoModelForCausalLM as ModelClass
from peft import LoraConfig, get_peft_model
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets, transformers, peft, bitsandbytes
print(f"versions: torch={torch.__version__} transformers={transformers.__version__} "
      f"peft={peft.__version__} bnb={bitsandbytes.__version__}", flush=True)

# ---- hybrid attention (GEMMA3N ONLY) — verified numerically exact vs eager (max|Δ|~0.01 at bf16 noise).
# Registered under "flash_attention_2": the 35 head_dim-256 layers keep transformers' flash path (incl.
# sliding-window); the 7 head_dim-512 full-attention layers (which flash rejects) divert to xformers.
# A standard LM has no such split, so this block is skipped for it (it would wrongly route ALL attention).
if CFG["hybrid_attn"]:
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

MAXLEN  = int(os.environ.get("MAXLEN", "40960"))  # v10 long rows reach ~78K -> set MAXLEN=65536
MODEL   = CFG["model_id"]
if not MODEL:
    raise SystemExit(f"FATAL: BASE={BASE} needs a model id. Set BASE_MODEL=<hf/repo> (fp16 safetensors, NOT a GGUF).")
EPOCHS  = float(os.environ.get("EPOCHS", "2"))
MAX_STEPS = int(os.environ.get("MAX_STEPS", "-1"))  # >0 caps total optim steps (overrides EPOCHS)
OUT_DIR = os.environ.get("OUT_DIR", "./adapter")

# ---- optional discovery mode: print the base's rendered template so you can read off the mask markers ----
if os.environ.get("DISCOVER") == "1":
    _t = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=CFG["trust_remote_code"])
    demo = [{"role": "user", "content": "open settings"},
            {"role": "assistant", "content": "I'll tap settings.",
             "tool_calls": [{"type": "function", "function": {"name": "tap", "arguments": {"x": 0.5, "y": 0.5}}}]},
            {"role": "tool", "content": "Saved: /tmp/a.png"}]
    try:
        rendered = _t.apply_chat_template(demo, tools=[{"type": "function", "function": {"name": "tap",
                   "description": "tap", "parameters": {"type": "object", "properties": {}}}}], tokenize=False)
    except Exception as e:
        rendered = f"(apply_chat_template with tools failed: {e}; does this template support tools?)"
    print("=" * 80 + f"\nRENDERED TEMPLATE for {MODEL}:\n" + "=" * 80 + f"\n{rendered}\n" + "=" * 80)
    print("Read the turn / tool_call / tool_response delimiters above and set MASK_* env vars accordingly.")
    sys.exit(0)

# ---- data discovery FIRST (fail fast, before the model download/quantize) ----
def _find(split):
    root = os.environ.get("DATA_DIR", "./data")
    c = glob.glob(f"{root}/**/{split}.jsonl", recursive=True) or glob.glob(f"/kaggle/input/**/{split}.jsonl", recursive=True)
    if not c:
        raise FileNotFoundError(f"{split}.jsonl not found under DATA_DIR={root!r} (or /kaggle/input). "
                                f"Put train.jsonl there or set DATA_DIR.")
    return c[0]
TRAIN_PATH = _find("train")
print(f"data: {TRAIN_PATH}", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=CFG["trust_remote_code"])
TKZ = getattr(tok, "tokenizer", tok)
PAD = tok.pad_token_id if tok.pad_token_id is not None else 0

# ---- completion-only label mask. The delimiters come from CFG so a new base only needs its markers.
# A model block runs from turn-open to the next turn-close OR end-of-text; assistant-generated = block
# content minus the tool_response (environment) spans.
for _k in ("model_block_re", "tool_resp_re", "turn_re", "turn_close", "toolresp_close", "toolcall_close"):
    if not CFG[_k]:
        raise SystemExit(f"FATAL: BASE={BASE} is missing mask marker {_k!r}. "
                         f"Run `BASE={BASE} DISCOVER=1 python h100_train.py` to read the template, then set the MASK_* env vars.")
MODEL_BLOCK = re.compile(CFG["model_block_re"], re.DOTALL)
TOOL_RESP   = re.compile(CFG["tool_resp_re"], re.DOTALL)
_TURN       = re.compile(CFG["turn_re"], re.DOTALL)
_TURN_CLOSE = CFG["turn_close"]; _TRESP_CLOSE = CFG["toolresp_close"]; _TCALL_CLOSE = CFG["toolcall_close"]

# REORDER_THOUGHT=1: templates that render a model turn as tool_call -> tool_response -> content train the
# model to think AFTER acting (useless). This moves a trailing thought to the FRONT of the turn, so training
# is think-THEN-act, matching the inference generation order. Keyed off the tool_response/tool_call close markers.
def _reorder_thought_first(txt):
    def fix(m):
        head, body, tail = m.group(1), m.group(2), m.group(3)
        p1, p2 = body.rfind(_TRESP_CLOSE), body.rfind(_TCALL_CLOSE)
        if p1 < 0 and p2 < 0:
            return m.group(0)  # pure-text turn (final answer) -> leave
        cut = (p1 + len(_TRESP_CLOSE)) if p1 >= 0 else (p2 + len(_TCALL_CLOSE))
        thought = body[cut:].strip()
        if not thought:
            return m.group(0)  # no trailing reasoning -> leave
        return head + thought + "\n" + body[:cut] + tail
    return _TURN.sub(fix, txt)

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
        if mt.group(0).endswith(_TURN_CLOSE):
            spans.append((mt.end(1), mt.end()))  # the closing turn marker -> learn to stop
    return spans

def build_example(messages, tools):
    txt = tok.apply_chat_template(messages, tools=tools, tokenize=False)
    if os.environ.get("REORDER_THOUGHT") == "1":
        txt = _reorder_thought_first(txt)
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
        if len(ids) > MAXLEN:  # DROP over-length rows (right-trunc would cut the labeled answer off the end)
            over += 1; continue
        if not any(l != -100 for l in labels):
            skipped += 1; continue
        rows.append({"input_ids": ids, "labels": labels})
        ntok += len(ids); nlab += sum(1 for l in labels if l != -100)
    print(f"{split}: {len(rows)} rows | labeled {nlab}/{ntok} = {100*nlab/max(ntok,1):.2f}% "
          f"| skipped_empty={skipped} truncated={over}", flush=True)
    if not rows:
        raise SystemExit(f"FATAL: 0 usable {split} rows. If skipped_empty is high, the mask markers for "
                         f"BASE={BASE} don't match this base's template (run DISCOVER=1).")
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
model = ModelClass.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.bfloat16, attn_implementation=CFG["attn_impl"],
    device_map={"": 0}, trust_remote_code=CFG["trust_remote_code"])
model.config.use_cache = False
for p in model.parameters():
    p.requires_grad = False  # base frozen; LoRA adapters are the only trainable params
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
_R = int(os.environ.get("LORA_R", "16"))
_ALPHA = int(os.environ.get("LORA_ALPHA", "16"))
lora = LoraConfig(r=_R, lora_alpha=_ALPHA, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=CFG["lora_targets"])
model = get_peft_model(model, lora); model.print_trainable_parameters()
_LCE = LigerFusedLinearCrossEntropyLoss()  # ignore_index=-100 -> masked (prompt/tool-result) tokens skipped

# Liger fused-linear CE, keyed by where the inner decoder + unembedding weight live for this arch.
def _decoder_and_unembed(m):
    m = m.get_base_model() if hasattr(m, "get_base_model") else m
    if CFG["loss_mode"] == "liger_inner_text":   # gemma3n multimodal: text LM is an inner submodule
        base = m.model.language_model
        return base, base.embed_tokens.weight
    # liger_causal: standard HF CausalLM (Llama/Qwen/Mistral/...): m.model = decoder, m.lm_head = unembedding
    base = m.model
    W = m.lm_head.weight if getattr(m, "lm_head", None) is not None else m.model.embed_tokens.weight
    return base, W

class LigerCETrainer(Trainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        base, W = _decoder_and_unembed(model)
        out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
        hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
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
        warmup_ratio=0.03, learning_rate=2e-4, logging_steps=5, save_steps=50,
        save_total_limit=int(os.environ.get("SAVE_TOTAL_LIMIT", "2")),
        optim="adamw_8bit", gradient_checkpointing=False, fp16=False, bf16=True,
        lr_scheduler_type="cosine", report_to="none", remove_unused_columns=False, output_dir="./out"))
import glob as _glob
_cks = sorted(_glob.glob("./out/checkpoint-*"), key=lambda p: int(p.rsplit("-", 1)[-1]))
_resume = _cks[-1] if _cks else None
print(f"resume_from_checkpoint = {_resume}", flush=True)
trainer.train(resume_from_checkpoint=_resume)
model.save_pretrained(OUT_DIR)
tok.save_pretrained(OUT_DIR)
open("./TRAIN_OK.txt", "w").write("ok")
print(f"=== TRAIN_OK — adapter saved to {os.path.abspath(OUT_DIR)} ===", flush=True)
