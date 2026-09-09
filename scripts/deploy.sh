#!/usr/bin/env bash
#
# Build and start the whole stack on a VPS.
#
#   ./scripts/deploy.sh                       plain HTTP on the server's IP
#   ./scripts/deploy.sh invoices.example.com  HTTPS, certificate from Caddy
#
# Safe to run again on the same machine: it rebuilds the images, applies any
# new migrations, and leaves the database, uploads and certificates alone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
DOMAIN="${1:-}"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Prerequisites ----------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. On a fresh Ubuntu VPS:

  curl -fsSL https://get.docker.com | sh

Then run this script again."
fi

if ! docker compose version >/dev/null 2>&1; then
  die "The Docker Compose plugin is missing. Install docker-compose-plugin, or
reinstall Docker with: curl -fsSL https://get.docker.com | sh"
fi

if ! docker info >/dev/null 2>&1; then
  die "Cannot talk to the Docker daemon. Start it with 'sudo systemctl start docker',
or re-run this script with sudo."
fi

# --- Settings ---------------------------------------------------------------

if [ ! -f .env ]; then
  log "First run: creating .env from deploy/env.example"
  cp deploy/env.example .env

  if command -v openssl >/dev/null 2>&1; then
    password="$(openssl rand -hex 24)"
  else
    password="$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 48)"
  fi
  # Alphanumeric only: the value is interpolated into a connection URL.
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${password}|" .env
  echo "    Generated a database password and stored it in .env"
fi

if [ -n "$DOMAIN" ]; then
  log "Serving https://${DOMAIN}"
  sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${DOMAIN}|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${DOMAIN}|" .env
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is empty in .env}"

# --- Build and start --------------------------------------------------------

# One service at a time: both images run a full dependency install, and doing
# them at once is what puts a 4GB VPS under memory pressure during a deploy.
log "Building the API image (first run downloads the base image; give it a few minutes)"
docker compose -f "$COMPOSE_FILE" build server

log "Building the web image"
docker compose -f "$COMPOSE_FILE" build web

log "Starting the stack"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

# --- Wait for the API -------------------------------------------------------

# The container's own healthcheck calls /api/health, so asking Docker for it
# needs neither curl on the host nor a published port.
log "Waiting for the API to report healthy"
container="$(docker compose -f "$COMPOSE_FILE" ps -q server)"
deadline=$(( SECONDS + 240 ))

while true; do
  state="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)"
  [ "$state" = "healthy" ] && break

  if [ "$state" = "unhealthy" ] || [ "$SECONDS" -ge "$deadline" ]; then
    printf '\n'
    docker compose -f "$COMPOSE_FILE" ps
    die "The API did not come up (last state: $state). Logs:

  docker compose -f $COMPOSE_FILE logs --tail 100 server"
  fi
  printf '.'
  sleep 3
done

printf '\n'
docker compose -f "$COMPOSE_FILE" ps

if [ "${SITE_ADDRESS:-:80}" = ":80" ]; then
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo 'your-server-ip')"
  address="http://${ip}"
  [ "${HTTP_PORT:-80}" = "80" ] || address="${address}:${HTTP_PORT}"
else
  address="https://${SITE_ADDRESS}"
fi

log "Running at ${address}"
echo "    Logs:    docker compose -f $COMPOSE_FILE logs -f"
echo "    Stop:    docker compose -f $COMPOSE_FILE down"
echo "    Update:  git pull && ./scripts/deploy.sh"
echo
