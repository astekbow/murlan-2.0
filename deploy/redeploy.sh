#!/usr/bin/env bash
# Pull the latest code, then rebuild + restart the full Murlan stack (with the
# HTTPS/Caddy overlay). Run from anywhere on the server:  bash deploy/redeploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest code…"
git pull

echo "==> Rebuilding + restarting (a few minutes the first time)…"
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up --build -d

echo "==> Status:"
docker compose -f docker-compose.yml -f docker-compose.deploy.yml ps

echo "==> Done. Hard-refresh your browser (PWA may be cached)."
