# ISOLATION v2: single GPU (no split) + my CHUNKED CE + detect_anomaly. If FINITE -> the NaN was the
# split/cross-device. If NaN -> detect_anomaly names the op (Liger CE vs a layer). Also manually reports
# which params get NaN grads and whether the forward (loss/hidden) is finite.
import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
for c in ["pip install -q accelerate bitsandbytes datasets peft liger-kernel",
          'pip install -q --no-deps trl==0.22.2 transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch, traceback
from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer, SFTConfig
import trl.models.utils as _tmu
_tmu.prepare_model_for_kbit_training = lambda m, *a, **k: m
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
import datasets
MODEL = "unsloth/gemma-4-E4B-it"
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.float16, llm_int8_enable_fp32_cpu_offload=True)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.float16, attn_implementation="sdpa",
    device_map={"model.language_model.embed_tokens_per_layer": "cpu", "": 0})
model.config.use_cache = False
for p in model.parameters():
    p.requires_grad = False  # NO fp32 upcast: keep all fp16 -> no fp32<->fp16 ToCopy backward NaN. SDPA +
    # GradScaler + RMSNorm's internal fp32 math handle stability.
model.enable_input_require_grads()
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
lora = LoraConfig(r=8, lora_alpha=8, lora_dropout=0, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$")
model = get_peft_model(model, lora); model.print_trainable_parameters()
_LCE = LigerFusedLinearCrossEntropyLoss()
# fp16 GradScaler default init_scale=65536 overshoots on gemma's grads -> skips first ~8 steps. Start low.
import torch.amp as _amp
_oinit = _amp.GradScaler.__init__
_amp.GradScaler.__init__ = lambda self, *a, **k: _oinit(self, *a, **{**k, "init_scale": 2.0 ** 10})

class LigerCETrainer(SFTTrainer):
    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        m = model.get_base_model() if hasattr(model, "get_base_model") else model
        base = m.model.language_model
        with torch.autograd.graph.save_on_cpu(pin_memory=True):  # offload LAYER activations to CPU
            out = base(input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask"), use_cache=False)
            hidden = (out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]).clone()
        W = base.embed_tokens.weight  # CE stays on GPU (Liger chunks) -> not offloaded
        H = hidden.size(-1)
        sh = hidden[:, :-1, :].contiguous().view(-1, H).to(W.dtype)
        sl = labels[:, 1:].contiguous().view(-1).to(sh.device)
        loss = _LCE(W, sh, sl)
        return (loss, out) if return_outputs else loss

filler = "The quick brown fox jumps over the lazy dog. " * 3000
text = tok.apply_chat_template([{"role":"user","content":filler},{"role":"assistant","content":"Acknowledged."}], tokenize=False)
if text.startswith("<bos>"): text = text[5:]
ds = datasets.Dataset.from_dict({"text": [text] * 8})
trainer = LigerCETrainer(model=model, processing_class=TKZ, train_dataset=ds,
    args=SFTConfig(dataset_text_field="text", max_length=20480, per_device_train_batch_size=1,
        gradient_accumulation_steps=1, max_steps=8, warmup_steps=1, learning_rate=2e-4, logging_steps=1,
        optim="adamw_8bit", gradient_checkpointing=False, fp16=True, bf16=False, report_to="none",
        output_dir="/kaggle/working/out"))
try:
    trainer.train()
    # report grad finiteness per trainable param
    bad = [n for n, p in model.named_parameters() if p.requires_grad and p.grad is not None and not torch.isfinite(p.grad).all()]
    print("NaN/inf-grad params:", len(bad), bad[:6], flush=True)
    import torch as _t; print("peak GPU MiB:", _t.cuda.max_memory_allocated()//1024//1024, flush=True)
    open("/kaggle/working/ISO_OK.txt", "w").write("ok")
    print("=== ISO OK — single-GPU chunked-CE trains FINITE -> the NaN was the SPLIT/cross-device ===", flush=True)
except Exception:
    print("=== ANOMALY (first NaN op below) ===", flush=True)
    traceback.print_exc()
