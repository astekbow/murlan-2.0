#!/usr/bin/env bash
# Resolve the current content digests for the Dockerfile base images, so you can PIN
# them for reproducible, tamper-evident builds (audit DOCKER-1). Run this on a host
# WITH Docker, then replace the `FROM image:tag` lines in Dockerfile.server /
# Dockerfile.client with the printed `FROM image:tag@sha256:...` lines and commit.
#
# It only READS (imagetools inspect) — it edits nothing, so it's safe to run anywhere
# Docker is available. Re-run periodically to roll the pins forward to fresh patches.
set -euo pipefail

images=("node:22-alpine" "nginx:1.27-alpine")

echo "Pinned FROM lines — paste these over the matching FROM lines in the Dockerfiles:"
echo "------------------------------------------------------------------------"
for ref in "${images[@]}"; do
  if ! digest="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null)"; then
    echo "  ⚠️  could not resolve $ref (is Docker running + online?)"
    continue
  fi
  echo "  FROM ${ref}@${digest}"
done
echo "------------------------------------------------------------------------"
echo "Dockerfile.server: pin the two 'FROM node:22-alpine ...' lines."
echo "Dockerfile.client: pin 'FROM node:22-alpine AS build' and 'FROM nginx:1.27-alpine AS runtime'."
echo "(Keep the ' AS <stage>' suffix; just insert @sha256:... before it.)"
