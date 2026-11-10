#!/usr/bin/env bash
# Open a bash shell in the ocmicro-free container, with the same mounts the agent gets.
# From there, start the agent with: python3 /app/main.py
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$dir/workspace" "$dir/logs"
docker build -t ocmicro-free "$dir"
exec docker run --rm -it \
  -v "$dir/.groq_key:/app/.groq_key:ro" \
  -v "$dir/workspace:/workspace" \
  -v "$dir/logs:/app/logs" \
  --entrypoint bash \
  ocmicro-free
