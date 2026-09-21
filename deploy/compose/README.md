# Deploying with Docker Compose

Five containers — PostgreSQL, Redis, a one-shot migration, the API, and nginx
serving the compiled client — from one file.

```bash
cd deploy/compose
cp .env.example .env
$EDITOR .env          # set POSTGRES_PASSWORD
docker compose up -d --build
```

The first build takes a few minutes (it installs dependencies and compiles
both packages). When it finishes the app is on <http://localhost:8080>.

```bash
docker compose ps         # what is running, and whether it is healthy
docker compose logs -f api
docker compose down       # stop; volumes and their data stay
```

## Requirements

| | |
| --- | --- |
| Docker Engine | 24+, with the Compose plugin (`docker compose`, not `docker-compose`) |
| Memory | 2GB. The Vite build is what gets killed with less |
| Disk | 3GB for the images, plus whatever the uploaded PDFs come to |
| Architecture | amd64 or arm64 |

Nothing else is needed on the host. Node, PostgreSQL, Redis and nginx all live
inside the images.

## This is not the compose file at the repository root

`docker-compose.yml` in the project root starts PostgreSQL and Redis and
nothing else, so that the app can be run from source with `npm run dev`. It is
a development dependency, not a deployment.

This directory is the deployment: it builds the app and runs all of it. The two
never run at the same time — both want port 5432 free, and the root one
publishes it.

## What runs

| Service | Image | Published | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | no | Data in the `postgres-data` volume |
| `redis` | `redis:7-alpine` | no | The processing queue. Persistence off on purpose |
| `migrate` | built (`api` target) | no | `prisma migrate deploy`, then exits |
| `api` | built (`api` target) | no | Express, the queue worker, and the WebSocket |
| `web` | built (`web` target) | `8080` | nginx: static bundle, and a proxy for the rest |

Only `web` is published. The browser reaches the API at `/api`, `/ws` and
`/uploads` on that same port, proxied — which is why no CORS configuration is
needed and why nothing else has to be exposed.

Startup is ordered by health, not by hope: `migrate` waits for PostgreSQL to
accept connections, `api` waits for `migrate` to exit cleanly, and `web` waits
for `/api/health` to answer. Migrations run in their own container rather than
from the API's entrypoint so that scaling the API to more than one replica
cannot have two of them migrating at once.

## Configuration

Everything is in `.env`, which is both what Compose substitutes into
`compose.yaml` and what the api container receives. `.env.example` lists every
setting with its default; only `POSTGRES_PASSWORD` must be changed.

Four values are set by `compose.yaml` itself and ignored in `.env`, because
they describe the topology rather than a preference: `DATABASE_URL` and
`REDIS_URL` (built from the service names), and `UPLOADS_DIR` and
`OCR_CACHE_DIR` (which must point at the volumes).

Two pairs have to move together:

- **`MAX_FILE_SIZE` and `MAX_UPLOAD_MB`.** The first is the API's limit in
  bytes, the second is nginx's in megabytes, and nginx sees the request first.
  Leave the couple of megabytes of headroom the example has: a request that
  exceeds nginx's limit is cut off without the API's explanation.
- **`PAGE_DPI` and the client.** The client is compiled with the same value, so
  changing it needs `docker compose up -d --build` rather than a restart.

## Upgrading

```bash
git pull
docker compose up -d --build
```

New migrations are applied by the `migrate` container before the API starts. No
step is needed for them.

## Backups

Two things hold state: the database, and the `uploads` volume with the original
PDFs and every page image rendered from them.

```bash
# Database
docker compose exec -T postgres pg_dump -U invoice invoice_processor > backup.sql

# Uploads
docker run --rm -v clurkpdf_uploads:/data -v "$PWD:/out" alpine \
  tar czf /out/uploads.tar.gz -C /data .
```

The `tesseract-cache` volume is not worth backing up — it is a ~5MB language
file that downloads itself again when missing.

## Behind a domain

The `web` container speaks plain HTTP on port 80 and does not manage
certificates. To put it on the internet, either front it with something that
terminates TLS (a reverse proxy, a load balancer, Cloudflare) and point that at
`WEB_PORT`, or use [the VPS installer](../README.md), which installs nginx and
a Let's Encrypt certificate on the host directly.

When TLS is terminated upstream, that proxy must forward `Upgrade` and
`Connection` headers on `/ws`, or live progress falls back to a reconnect loop
that never succeeds.

## Troubleshooting

**`POSTGRES_PASSWORD is not set`** — Compose is running somewhere other than
this directory, or `.env` does not exist yet. `cd deploy/compose` and copy it.

**`migrate` exits non-zero and the API never starts.** Its log says why; the
usual cause is a password changed in `.env` after the database volume was
created, which does not change the password already stored in it. Either put
the old password back, or `docker compose down -v` to discard the database and
start again — that deletes the uploads too.

**Uploads fail at around 10MB.** `MAX_FILE_SIZE` and `MAX_UPLOAD_MB` both need
raising; see above.

**Progress bars never move, and the console shows a 403 on `/ws`.** The API
allows a socket from a configured origin, or from the address the request
arrived on. The `web` container forwards that address intact; another proxy in
front of it may not, in which case add the URL people actually type to
`CLIENT_ORIGIN` — scheme, host and port, exactly as the browser sends it.

**The first OCR run fails with a fetch error.** Tesseract downloads its
language data (~5MB) the first time it recognises anything, so the `api`
container needs outbound HTTPS on that first run. It is cached in the
`tesseract-cache` volume afterwards; somewhere without egress, populate that
volume from a machine that has it.

**The build is killed.** The Vite build needs roughly 2GB. Give Docker Desktop
more memory, or add swap on a small VPS.
