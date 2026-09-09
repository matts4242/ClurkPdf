#!/bin/sh
# Bring the schema up to date, then hand off to the server.
#
# `migrate deploy` only applies migrations that are already committed — it
# never generates one and never resets data — so it is safe to run on every
# start, including a restart after a crash.
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set; refusing to start." >&2
  exit 1
fi

echo "Applying database migrations..."
npx prisma migrate deploy

exec "$@"
