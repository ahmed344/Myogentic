#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "Install uv from https://docs.astral.sh/uv/getting-started/installation/ first."; exit 1; }
export UV_CACHE_DIR="$PWD/.cache/uv"
uv sync --locked
if [ -x .tools/node/bin/node ]; then
  export PATH="$PWD/.tools/node/bin:$PATH"
elif ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  .venv/bin/python scripts/install-node.py
  export PATH="$PWD/.tools/node/bin:$PATH"
fi
cd frontend
npm ci --cache ../.cache/npm
npm run build
echo "Setup complete. Run ./start.sh from the annotator directory."
