#!/usr/bin/env python3
"""Rewrite the fused (multimodal-layout) checkpoint as a text-only Gemma4ForCausalLM.

The mlx fuse emits a Gemma4ForConditionalGeneration checkpoint: tensors prefixed
`language_model.model.*` and a config declaring audio/vision. Ollama's converter
for that arch doesn't map the input embedding to the runtime's `token_embd.weight`
(load fails "missing tensor 'token_embd.weight'"). Presenting a plain causal LM —
`model.*` tensors + architectures ['Gemma4ForCausalLM'] from the text_config —
hits Ollama's text gemma4 path, which maps embeddings correctly.

Processes one shard at a time (peak ~one shard) to stay memory-frugal.
"""
import json
import shutil
from pathlib import Path

import mlx.core as mx

SRC = Path("fused/silver-e4b")
DST = Path("fused/silver-e4b-causal")
PREFIX = "language_model."  # language_model.model.* -> model.*


def main():
    DST.mkdir(parents=True, exist_ok=True)
    idx = json.loads((SRC / "model.safetensors.index.json").read_text())
    shards = sorted(set(idx["weight_map"].values()))
    new_map: dict[str, str] = {}

    for shard in shards:
        w = mx.load(str(SRC / shard))
        renamed = {}
        for k, v in w.items():
            nk = k[len(PREFIX):] if k.startswith(PREFIX) else k
            renamed[nk] = v
            new_map[nk] = shard
        mx.save_safetensors(str(DST / shard), renamed, metadata={"format": "mlx"})
        print(f"{shard}: {len(renamed)} tensors  (e.g. {next(iter(renamed))})")
        del w, renamed

    (DST / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": idx.get("metadata", {}), "weight_map": new_map}, indent=2)
    )

    # Text-only causal config from text_config.
    cfg = json.loads((SRC / "config.json").read_text())
    tc = dict(cfg["text_config"])
    tc["architectures"] = ["Gemma4ForCausalLM"]
    tc.setdefault("tie_word_embeddings", cfg.get("tie_word_embeddings", True))
    tc.setdefault("eos_token_id", cfg.get("eos_token_id"))
    tc["dtype"] = cfg.get("dtype", "bfloat16")
    (DST / "config.json").write_text(json.dumps(tc, indent=2))

    for name in ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "generation_config.json"]:
        if (SRC / name).exists():
            shutil.copy2(SRC / name, DST / name)

    print("model_type:", tc.get("model_type"), "| arch:", tc["architectures"],
          "| has token embed:", "model.embed_tokens.weight" in new_map)


if __name__ == "__main__":
    main()
