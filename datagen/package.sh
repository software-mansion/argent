#!/usr/bin/env bash
# Generalized adapter -> ollama packaging. Base-agnostic; DEFAULTS reproduce the gemma/silver path.
# peft-merge fp16 -> convert_hf_to_gguf -> quantize -> ollama create. Disk-safe ordering (drops the big
# intermediates before the next step) so it survives a near-full disk.
#
# Required env:  WORK  (adapter dir name under fused/, i.e. fused/<WORK>-adapter)
#                NAME  (ollama tag, e.g. silver-v10b:e4b)
# Optional env (defaults = gemma, so silver packages with just WORK+NAME):
#   BASE_MODEL   (fp16 HF repo the adapter was trained on)   default unsloth/gemma-4-E4B-it
#   MODEL_CLASS  (image_text_to_text | causal_lm)            default image_text_to_text
#   RENDERER     (ollama renderer matching the template)     default gemma4   <- MUST change per base
#   PARSER       (ollama parser matching the template)       default gemma4   <- MUST change per base
#   NUM_CTX      (serve context)                             default 131072
#   QUANT        (llama-quantize type)                       default Q6_K
#   TRUST_REMOTE_CODE (1 to allow custom arch code)          default 0
set -euo pipefail
cd /Users/ignacylatka/dev/argent-finetune-data/datagen
VENV=/Users/ignacylatka/dev/argent-finetune-data/.venv/bin/python
LC=$HOME/.cache/llama.cpp-convert
WORK="${WORK:?set WORK=<adapter dir name under fused/, e.g. silver-v10b>}"
NAME="${NAME:?set NAME=<ollama tag, e.g. silver-v10b:e4b>}"
export BASE_MODEL="${BASE_MODEL:-unsloth/gemma-4-E4B-it}"
export MODEL_CLASS="${MODEL_CLASS:-image_text_to_text}"
export TRUST_REMOTE_CODE="${TRUST_REMOTE_CODE:-0}"
RENDERER="${RENDERER:-gemma4}"; PARSER="${PARSER:-gemma4}"
NUM_CTX="${NUM_CTX:-131072}"; QUANT="${QUANT:-Q6_K}"

echo "=== 1) merge  base=$BASE_MODEL class=$MODEL_CLASS  $(date +%T) ==="
ADAPTER="$(pwd)/fused/$WORK-adapter" MERGED="$(pwd)/fused/$WORK-merged" "$VENV" local_merge.py

echo "=== 2) convert -> f16 GGUF  $(date +%T) ==="
"$VENV" "$LC/convert_hf_to_gguf.py" "fused/$WORK-merged" --outfile "fused/$WORK.f16.gguf" --outtype f16

echo "=== 2b) drop merged fp16 (free disk before quantize)  $(date +%T) ==="
rm -rf "fused/$WORK-merged"

echo "=== 3) quantize $QUANT  $(date +%T) ==="
llama-quantize "fused/$WORK.f16.gguf" "fused/$WORK.$QUANT.gguf" "$QUANT"

echo "=== 3b) drop f16 (free disk before ollama copies the quant)  $(date +%T) ==="
rm -f "fused/$WORK.f16.gguf"

echo "=== 4) ollama create $NAME  (renderer=$RENDERER parser=$PARSER ctx=$NUM_CTX)  $(date +%T) ==="
MF=$(mktemp)
printf 'FROM %s/fused/%s.%s.gguf\nTEMPLATE """{{ .Prompt }}"""\nRENDERER %s\nPARSER %s\nPARAMETER num_ctx %s\nPARAMETER temperature 0\n' \
  "$(pwd)" "$WORK" "$QUANT" "$RENDERER" "$PARSER" "$NUM_CTX" > "$MF"
ollama rm "$NAME" >/dev/null 2>&1 || true
ollama create "$NAME" -f "$MF"
echo "=== PACKAGED_OK $NAME  ($(du -h fused/$WORK.$QUANT.gguf | cut -f1))  $(date +%T) ==="
ollama list | grep "${NAME%%:*}" || true
