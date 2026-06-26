#!/usr/bin/env bash
# Resume silver-v7 packaging from step 2 (merge already done in fused/silver-v7-merged).
set -euo pipefail
cd /Users/ignacylatka/dev/argent-finetune-data/datagen
VENV=/Users/ignacylatka/dev/argent-finetune-data/.venv/bin/python
LC=$HOME/.cache/llama.cpp-convert
WORK=silver-v7
NAME="silver-v7:e4b-text-Q6-K"

echo "=== 2) convert -> f16 GGUF (auto-extracts text LM)  $(date +%T) ==="
"$VENV" "$LC/convert_hf_to_gguf.py" "fused/$WORK-merged" --outfile "fused/$WORK.f16.gguf" --outtype f16

echo "=== 3) quantize Q6_K  $(date +%T) ==="
llama-quantize "fused/$WORK.f16.gguf" "fused/$WORK.Q6_K.gguf" Q6_K

echo "=== 4) ollama create $NAME  $(date +%T) ==="
MF=$(mktemp)
printf 'FROM %s/fused/%s.Q6_K.gguf\nTEMPLATE """{{ .Prompt }}"""\nRENDERER gemma4\nPARSER gemma4\nPARAMETER num_ctx 131072\nPARAMETER temperature 0\n' "$(pwd)" "$WORK" > "$MF"
ollama rm "$NAME" >/dev/null 2>&1 || true
ollama create "$NAME" -f "$MF"

echo "=== 5) cleanup intermediates  $(date +%T) ==="
rm -rf "fused/$WORK-merged" "fused/$WORK.f16.gguf"
echo "=== PACKAGED_OK $NAME  $(date +%T) ==="
ollama list | grep silver-v7 || true
