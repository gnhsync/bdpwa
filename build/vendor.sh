#!/usr/bin/env bash
# Download all vendored files into <destdir>.
# Usage: bash build/vendor.sh <destdir>
set -euo pipefail

DEST="${1:?Usage: $0 <destdir>}"
HF="https://huggingface.co/Xenova/bge-base-en-v1.5/resolve/main"

mkdir -p "$DEST/js" "$DEST/models/Xenova/bge-base-en-v1.5/onnx"

curl -fL# -o "$DEST/js/transformers.min.js" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js"

for f in config.json tokenizer_config.json tokenizer.json special_tokens_map.json vocab.txt; do
  curl -fL# -o "$DEST/models/Xenova/bge-base-en-v1.5/$f" "$HF/$f"
done

curl -fL# -o "$DEST/models/Xenova/bge-base-en-v1.5/onnx/model_quantized.onnx" \
  "$HF/onnx/model_quantized.onnx"

echo "Done."
