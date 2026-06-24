# Is my chunked CE correct? Compare against the model's OWN loss (ground truth) on a short seq where full
# logits fit. Also probe fp16 NaN: print where non-finite values first appear in a forward+backward.
import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
for c in ["pip install -q accelerate bitsandbytes peft liger-kernel",
          'pip install -q --no-deps transformers==5.5.0 "tokenizers>=0.22.0,<=0.23.0"',
          "pip install -q --no-deps --upgrade timm"]:
    os.system(c)
import torch, torch.nn.functional as F
from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from liger_kernel.transformers import LigerFusedLinearCrossEntropyLoss
MODEL = "unsloth/gemma-4-E4B-it"
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                         bnb_4bit_compute_dtype=torch.float16)
model = AutoModelForImageTextToText.from_pretrained(
    MODEL, quantization_config=bnb, dtype=torch.float16, attn_implementation="eager", device_map={"": 0})
tok = AutoTokenizer.from_pretrained(MODEL); TKZ = getattr(tok, "tokenizer", tok)
text = "The capital of France is Paris. The Eiffel Tower stands in Paris. " * 8
ids = TKZ(text, return_tensors="pt").input_ids[:, :256].cuda()
labels = ids.clone()
model.eval()
base = model.model.language_model
print("embed_tokens.weight:", base.embed_tokens.weight.dtype, tuple(base.embed_tokens.weight.shape), flush=True)
print("lm_head:", type(model.lm_head).__name__, "tied:", model.lm_head.weight.data_ptr() == base.embed_tokens.weight.data_ptr(), flush=True)
with torch.no_grad():
    ref = model(input_ids=ids, labels=labels)
    print("REF model.loss            :", ref.loss.item(), flush=True)
    out = base(input_ids=ids)
    hidden = out.last_hidden_state
    print("hidden:", hidden.dtype, tuple(hidden.shape), "finite:", torch.isfinite(hidden).all().item(), flush=True)
    W = base.embed_tokens.weight
    sh = hidden[:, :-1, :].contiguous().view(-1, hidden.size(-1))
    sl = labels[:, 1:].contiguous().view(-1)
    print("MY Liger chunked CE       :", LigerFusedLinearCrossEntropyLoss()(W, sh, sl).item(), flush=True)
    print("MANUAL embed_tokens CE     :", F.cross_entropy(sh.float() @ W.float().t(), sl).item(), flush=True)
    lmh = model.lm_head(hidden)[:, :-1, :].contiguous().view(-1, W.size(0))
    print("MODEL lm_head CE          :", F.cross_entropy(lmh.float(), sl).item(), flush=True)
# fp16 grad probe: tiny LoRA-free backward through one matmul to see if NaN is intrinsic
print("=== CECHECK DONE ===", flush=True)
