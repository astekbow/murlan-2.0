#!/usr/bin/env bash
# Resolve the current content digests for the Dockerfile base images, so you can PIN
# them for reproducible, tamper-evident builds (audit DOCKER-1). Run this on a host
# WITH Docker, then replace the `FROM image:tag` lines in Dockerfile.server /
# Dockerfile.client with the printed `FROM image:tag@sha256:...` lines and commit.
#
# It only READS (imagetools inspect) — it edits nothing, so it's safe to run anywhere
# Docker is available. Re-run periodically to roll the pins forward to fresh patches.
set -euo pipefail

# Dockerfile base images (the `FROM` lines).
dockerfile_images=("node:22-alpine" "nginx:1.27-alpine")
# docker-compose service images (the `image:` keys). prom/*:latest is the most
# important to pin — a floating :latest can pull a different Prometheus/Alertmanager
# on any rebuild of a real-money host.
compose_images=("postgres:16-alpine" "redis:7-alpine" "caddy:2-alpine" "prom/prometheus:latest" "prom/alertmanager:latest" "prodrigestivill/postgres-backup-local:16")

resolve() { docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}' 2>/dev/null; }

echo "== Dockerfiles — paste over the matching FROM lines =="
echo "------------------------------------------------------------------------"
for ref in "${dockerfile_images[@]}"; do
  if ! digest="$(resolve "$ref")"; then echo "  ⚠️  could not resolve $ref (is Docker running + online?)"; continue; fi
  echo "  FROM ${ref}@${digest}"
done
echo "------------------------------------------------------------------------"
echo "Dockerfile.server: pin the two 'FROM node:22-alpine ...' lines."
echo "Dockerfile.client: pin 'FROM node:22-alpine AS build' and 'FROM nginx:1.27-alpine AS runtime'."
echo "(Keep the ' AS <stage>' suffix; just insert @sha256:... before it.)"
echo
echo "== docker-compose — paste over the matching 'image:' values =="
echo "   (docker-compose.yml + docker-compose.deploy.yml)"
echo "------------------------------------------------------------------------"
for ref in "${compose_images[@]}"; do
  if ! digest="$(resolve "$ref")"; then echo "  ⚠️  could not resolve $ref (is Docker running + online?)"; continue; fi
  echo "  image: ${ref}@${digest}"
done
echo "------------------------------------------------------------------------"
echo "Re-run periodically to roll the pins forward to fresh security patches."
