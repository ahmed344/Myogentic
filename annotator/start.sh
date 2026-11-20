#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ] || [ ! -f frontend/dist/index.html ]; then
  echo "Run ./setup.sh once before starting the annotator."
  exit 1
fi
echo "Myogentic Annotator: http://127.0.0.1:${MYOGENTIC_PORT:-8000}"
exec .venv/bin/python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port "${MYOGENTIC_PORT:-8000}"
