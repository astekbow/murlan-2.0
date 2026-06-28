#!/usr/bin/env bash
# FAST deploy: pull PRE-BUILT, CI-scanned images from GHCR instead of building on this (slow) host. The
# host never runs npm ci / vite build / prisma generate — it just pulls (~seconds) and restarts.
#
# Flow: push to main → GitHub Actions builds + Trivy-scans + pushes ghcr.io/astekbow/murlan-{server,client}
# → run this here once CI is green. Falls back to `bash deploy/redeploy.sh` if you ever need a host build.
#
# Run from anywhere on the server:  bash deploy/pull-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.deploy.yml -f docker-compose.ghcr.yml"

echo "==> Pulling latest code (compose files + the prisma migrations the server applies on boot)…"
git pull

# Snapshot the DB BEFORE the new server boots (it auto-runs `prisma migrate deploy` — a bad migration on a
# populated prod DB has no rollback without this). Same guard as redeploy.sh.
echo "==> Backing up the database before migrating…"
mkdir -p backups/predeploy
if $COMPOSE ps postgres 2>/dev/null | grep -qiE 'up|running|healthy'; then
  ts="$(date +%Y%m%d-%H%M%S)"
  dump="backups/predeploy/predeploy-$ts.sql.gz"
  if $COMPOSE exec -T postgres pg_dump -U "${POSTGRES_USER:-murlan}" "${POSTGRES_DB:-murlan}" | gzip > "$dump"; then
    sz="$(wc -c < "$dump" 2>/dev/null || echo 0)"
    if gzip -t "$dump" 2>/dev/null && [ "$sz" -gt 1024 ]; then
      echo "    saved + verified $dump ($sz bytes)"
    else
      echo "    WARNING: pre-deploy backup is CORRUPT or near-empty (gzip -t failed or <1KB) — aborting."
      exit 1
    fi
  else
    echo "    WARNING: pre-deploy backup FAILED — aborting (fix the DB or take a manual dump first)."
    exit 1
  fi
else
  echo "    (postgres not running yet — skipping, looks like a first deploy)"
fi

echo "==> Pulling pre-built images from GHCR (public — no login needed)…"
$COMPOSE pull server client

echo "==> Restarting (NO host build)…"
$COMPOSE up -d --no-build

echo "==> Status:"
$COMPOSE ps

echo "==> Done in seconds (no on-host build). Hard-refresh your browser (PWA may be cached)."
