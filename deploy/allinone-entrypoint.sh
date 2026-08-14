#!/bin/sh
# ============================================================================
# MURLAN — all-in-one container entrypoint (friends-server / single-container)
# ----------------------------------------------------------------------------
# Boots with ZERO required configuration: if the JWT/webhook secrets aren't
# provided via env, generate strong random ones. When a writable /data volume
# is mounted they are PERSISTED there, so restarts keep everyone's sessions;
# without a volume fresh secrets are generated each start (sessions reset —
# harmless for a casual friends server, and a warning says so).
# DB: with no DATABASE_URL the server runs fully in-memory (accounts reset on
# restart). Point DATABASE_URL at a Postgres to persist accounts.
# ============================================================================
set -eu

DATA_DIR="${DATA_DIR:-/data}"
SECRETS_FILE="$DATA_DIR/secrets.env"

# Reuse persisted secrets when present (only fills vars that aren't already set in env).
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
fi

gen() { openssl rand -hex 32; }

GENERATED=0
if [ -z "${JWT_ACCESS_SECRET:-}" ];      then JWT_ACCESS_SECRET="$(gen)";      GENERATED=1; fi
if [ -z "${JWT_REFRESH_SECRET:-}" ];     then JWT_REFRESH_SECRET="$(gen)";     GENERATED=1; fi
if [ -z "${PAYMENT_WEBHOOK_SECRET:-}" ]; then PAYMENT_WEBHOOK_SECRET="$(gen)"; GENERATED=1; fi
export JWT_ACCESS_SECRET JWT_REFRESH_SECRET PAYMENT_WEBHOOK_SECRET

if [ "$GENERATED" = "1" ]; then
  if mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then
    umask 077
    {
      echo "JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET"
      echo "JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET"
      echo "PAYMENT_WEBHOOK_SECRET=$PAYMENT_WEBHOOK_SECRET"
    } > "$SECRETS_FILE"
    echo "[entrypoint] generated secrets → persisted in $SECRETS_FILE (restarts keep sessions)"
  else
    echo "[entrypoint] WARNING: no writable $DATA_DIR volume — secrets are fresh each start (all sessions reset on restart). Mount a volume at $DATA_DIR to persist them."
  fi
fi

# Apply DB migrations only when a database is configured (else: in-memory mode).
if [ -n "${DATABASE_URL:-}" ]; then
  npx prisma migrate deploy --schema packages/server/prisma/schema.prisma || exit 1
else
  echo "[entrypoint] no DATABASE_URL — running fully in-memory (accounts/history reset on restart)"
fi

exec npm run start --workspace @murlan/server
