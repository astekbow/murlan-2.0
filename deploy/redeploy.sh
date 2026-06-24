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
  dump="backups/predeploy/predeploy-$ts.sql.gz"
  # Env-driven creds (infra-5): default to murlan/murlan so an existing deploy keeps
  # working; override POSTGRES_USER/POSTGRES_DB in the environment for a custom setup.
  if $COMPOSE exec -T postgres pg_dump -U "${POSTGRES_USER:-murlan}" "${POSTGRES_DB:-murlan}" | gzip > "$dump"; then
    # VERIFY the dump before trusting it: gzip integrity (not truncated/corrupt) AND a
    # sane minimum size (a populated DB dumps to many KB; <1KB means it captured ~nothing).
    sz="$(wc -c < "$dump" 2>/dev/null || echo 0)"
    if gzip -t "$dump" 2>/dev/null && [ "$sz" -gt 1024 ]; then
      echo "    saved + verified $dump ($sz bytes)"
    else
      echo "    WARNING: pre-deploy backup is CORRUPT or near-empty (gzip -t failed or <1KB) — aborting deploy."
      exit 1
    fi
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
