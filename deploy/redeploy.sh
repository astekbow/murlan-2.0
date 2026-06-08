#!/usr/bin/env bash
# Pull the latest code, then rebuild + restart the full Murlan stack (with the
# HTTPS/Caddy overlay). Run from anywhere on the server:  bash deploy/redeploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.deploy.yml"

echo "==> Pulling latest code…"
git pull

# Snapshot the DB BEFORE rebuilding (the server auto-runs `prisma migrate deploy`
# on boot — a bad migration on a populated prod DB has no rollback without this).
# Audit 2026-06-08, finding H6. Best-effort: skipped cleanly on a first deploy.
echo "==> Backing up the database before migrating…"
mkdir -p backups/predeploy
if $COMPOSE ps postgres 2>/dev/null | grep -qiE 'up|running|healthy'; then
  ts="$(date +%Y%m%d-%H%M%S)"
  if $COMPOSE exec -T postgres pg_dump -U murlan murlan | gzip > "backups/predeploy/predeploy-$ts.sql.gz"; then
    echo "    saved backups/predeploy/predeploy-$ts.sql.gz"
  else
    echo "    WARNING: pre-deploy backup FAILED — aborting deploy (fix the DB or take a manual dump first)."
    exit 1
  fi
else
  echo "    (postgres not running yet — skipping, looks like a first deploy)"
fi

echo "==> Rebuilding + restarting (a few minutes the first time)…"
$COMPOSE up --build -d

echo "==> Status:"
$COMPOSE ps

echo "==> Done. Hard-refresh your browser (PWA may be cached)."
