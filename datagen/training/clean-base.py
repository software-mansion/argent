#!/usr/bin/env python3
"""Materialize a strict-loadable local copy of an mlx gemma-4 checkpoint.

The mlx-community gemma-4 E4B quant ships redundant k_proj/v_proj/k_norm tensors
for its shared-KV layers (the top `num_kv_shared_layers` reuse a lower layer's
K/V, so mlx_lm's gemma4 model never instantiates those projections). mlx_lm's
`load()` is strict, so `mlx_lm.lora`, `fuse`, and serve.py all raise
"Received N parameters not in model" on the stock repo.

Loading non-strict and re-saving the model's *actual* parameter set drops the
vestigial tensors, yielding a checkpoint that loads strict-clean at every stage.

    python clean-base.py --repo mlx-community/gemma-4-e4b-it-4bit --out base/gemma-4-e4b-clean
"""
import argparse
import shutil
from pathlib import Path

import mlx.core as mx
from mlx.utils import tree_flatten
from huggingface_hub import snapshot_download
from mlx_lm.utils import load_model, load_tokenizer

# Non-weight files to carry over verbatim (config + tokenizer + templates).
COPY = [
    "config.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "generation_config.json",
    "chat_template.jinja",
    "chat_template.json",
    "preprocessor_config.json",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    src = Path(snapshot_download(args.repo))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Load non-strict: the model keeps only the params it actually uses.
    model, _ = load_model(src, strict=False)
    weights = dict(tree_flatten(model.parameters()))
    print(f"model parameters kept: {len(weights)}")

    for name in COPY:
        f = src / name
        if f.exists():
            shutil.copy2(f, out / name)
            print(f"copied {name}")

    mx.save_safetensors(str(out / "model.safetensors"), weights, metadata={"format": "mlx"})
    print(f"wrote {out / 'model.safetensors'}")

    # Prove it now loads strict-clean and still generates.
    m2, _ = load_model(out, strict=True)
    tok = load_tokenizer(out)
    from mlx_lm import generate
    from mlx_lm.sample_utils import make_sampler

    p = tok.apply_chat_template(
        [{"role": "user", "content": "Reply with exactly one word: ok"}],
        add_generation_prompt=True,
        tokenize=False,
    )
    out_text = generate(m2, tok, p, max_tokens=5, verbose=False, sampler=make_sampler(temp=0.0))
    print("strict reload OK; gen:", repr(out_text))


if __name__ == "__main__":
    main()
