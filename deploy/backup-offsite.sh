#!/usr/bin/env bash
# Copy the local DB backups OFF the server, so a disk failure or VPS loss doesn't
# take the real-money database *and* its only backups at the same time (audit
# 2026-06-08, finding H5 — the db-backup service writes to ./backups on the SAME
# host disk as the live DB).
#
# Setup (rclone — works with S3 / Backblaze B2 / Google Drive / etc.):
#   1. apt install rclone        (or: curl https://rclone.org/install.sh | sudo bash)
#   2. rclone config             (create a remote, e.g. named 'offsite')
#   3. export BACKUP_REMOTE=offsite:cryptomurlan-backups   (put this in your shell rc)
#
# Run on a cron AFTER the daily db-backup (which defaults to @daily). Example —
# every day at 04:30:
#   crontab -e
#   30 4 * * *  BACKUP_REMOTE=offsite:cryptomurlan-backups /full/path/murlan/deploy/backup-offsite.sh >> /var/log/murlan-offsite.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="./backups"
if [ ! -d "$SRC" ]; then
  echo "no $SRC directory yet — nothing to copy (has the db-backup service run?)"
  exit 0
fi
if [ -z "${BACKUP_REMOTE:-}" ]; then
  echo "ERROR: BACKUP_REMOTE is not set. This script refuses to no-op silently —"
  echo "set it (see this file's header) so offsite copies actually happen."
  exit 1
fi
if ! command -v rclone >/dev/null 2>&1; then
  echo "ERROR: rclone is not installed (apt install rclone)."
  exit 1
fi

echo "==> Syncing $SRC → $BACKUP_REMOTE …"
rclone sync "$SRC" "$BACKUP_REMOTE" --create-empty-src-dirs --transfers 4
echo "==> Offsite backup complete ($(date))."
