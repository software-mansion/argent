#!/usr/bin/env bash
# Package a native-format LoRA adapter into an Ollama model that is a true drop-in
# for gemma4 (RENDERER gemma4 + PARSER gemma4, no baked SYSTEM, only weights differ).
#
#   ./package-native.sh <adapter-dir> <ollama-name> <work-name>
#     ./package-native.sh adapters/silver-native silver-native:e4b silver-native
#
# Ollama's own gemma4 safetensors converter is broken, so we go via llama.cpp
# (cloned to ~/.cache/llama.cpp-convert) and import the GGUF.
set -euo pipefail
cd "$(dirname "$0")"
PY="../../.venv/bin/python"
ADAPTER="${1:?adapter dir}"; NAME="${2:?ollama name}"; WORK="${3:?work name}"
LC="$HOME/.cache/llama.cpp-convert"
[ -f "$LC/convert_hf_to_gguf.py" ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LC"

echo "=== 1) fuse + dequantize -> fused/$WORK  $(date +%T) ==="
"$PY" -m mlx_lm fuse --model base/gemma-4-e4b-clean --adapter-path "$ADAPTER" \
  --save-path "fused/$WORK" --dequantize
test -f "fused/$WORK/model.safetensors.index.json"

echo "=== 2) rewrite as text-only Gemma4ForCausalLM -> fused/$WORK-causal  $(date +%T) ==="
SRC="fused/$WORK" DST="fused/$WORK-causal" "$PY" - <<'PYEOF'
import json, shutil, os
from pathlib import Path
import mlx.core as mx
SRC=Path(os.environ["SRC"]); DST=Path(os.environ["DST"]); DST.mkdir(parents=True, exist_ok=True)
idx=json.loads((SRC/"model.safetensors.index.json").read_text())
new_map={}
for sh in sorted(set(idx["weight_map"].values())):
    w=mx.load(str(SRC/sh)); ren={}
    for k,v in w.items():
        nk=k[len("language_model."):] if k.startswith("language_model.") else k
        ren[nk]=v; new_map[nk]=sh
    mx.save_safetensors(str(DST/sh), ren, metadata={"format":"mlx"})
(DST/"model.safetensors.index.json").write_text(json.dumps({"metadata":idx.get("metadata",{}),"weight_map":new_map}))
cfg=json.loads((SRC/"config.json").read_text()); tc=dict(cfg["text_config"])
tc["architectures"]=["Gemma4ForCausalLM"]; tc.setdefault("tie_word_embeddings",cfg.get("tie_word_embeddings",True)); tc["dtype"]=cfg.get("dtype","bfloat16")
(DST/"config.json").write_text(json.dumps(tc,indent=2))
for n in ["tokenizer.json","tokenizer_config.json","chat_template.jinja","generation_config.json"]:
    if (SRC/n).exists(): shutil.copy2(SRC/n, DST/n)
print("causal rewrite done:", len(new_map), "tensors")
PYEOF

echo "=== 3) llama.cpp -> f16 GGUF  $(date +%T) ==="
"$PY" "$LC/convert_hf_to_gguf.py" "fused/$WORK-causal" --outfile "fused/$WORK.f16.gguf" --outtype f16 >/dev/null
test -f "fused/$WORK.f16.gguf"

echo "=== 4) ollama import (q4_K_M, PARSER gemma4, no SYSTEM)  $(date +%T) ==="
MF="$(mktemp)"
printf 'FROM %s/fused/%s.f16.gguf\nTEMPLATE """{{ .Prompt }}"""\nRENDERER gemma4\nPARSER gemma4\nPARAMETER num_ctx 32768\nPARAMETER temperature 0\n' "$(pwd)" "$WORK" > "$MF"
ollama rm "$NAME" >/dev/null 2>&1 || true
ollama create "$NAME" -q q4_K_M -f "$MF"
echo "=== PACKAGED $NAME  $(date +%T) ==="
