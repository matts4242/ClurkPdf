# Deploying to a VPS

The whole application runs as three containers, started by one command:

| Container | What it is |
| --- | --- |
| `web` | Caddy. Serves the built client and proxies `/api` and `/uploads` to the server. Gets an HTTPS certificate on its own if you give it a domain. |
| `server` | The Express API, with pdf.js and Tesseract. Applies database migrations on start. |
| `db` | PostgreSQL 16. Not published to the internet — only `server` can reach it. |

Written for a Hostinger VPS running Ubuntu 24.04, but nothing here is
Hostinger-specific; any Linux host with Docker will do.

## Sizing

OCR is the demanding part: each Tesseract worker is a WASM instance holding a
page image. **KVM 2 (2 vCPU, 8GB) is a comfortable starting point.** KVM 1 (1
vCPU, 4GB) works for one user at a time — leave `OCR_CONCURRENCY=2` alone, or
lower it to `1`.

## First deploy

SSH into the VPS as root (hPanel shows the address and password), then:

```bash
# 1. Docker, if the image did not come with it
curl -fsSL https://get.docker.com | sh

# 2. The code
apt-get install -y git
git clone https://github.com/matts4242/ClurkPdf.git
cd ClurkPdf

# 3. Everything else
./scripts/deploy.sh
```

The first build takes a few minutes — it downloads the base images and installs
dependencies. When it finishes it prints the address to open.

### With a domain

Point an `A` record at the VPS's IP address first, wait for it to resolve, then
pass the hostname:

```bash
./scripts/deploy.sh invoices.example.com
```

Caddy requests a Let's Encrypt certificate on startup and renews it from then
on. Ports 80 and 443 must both be reachable: the certificate check comes in on
80 even though the site ends up on 443.

### Firewall

Hostinger VPS instances have two firewalls, and both have to allow 80 and 443:

```bash
ufw allow 80/tcp && ufw allow 443/tcp    # on the machine
```

and in hPanel under **VPS → Firewall**, if you have a rule set attached.

## What `deploy.sh` does

1. Checks that Docker and the Compose plugin are installed and the daemon is up.
2. On the first run, copies `deploy/env.example` to `.env` and generates a
   database password.
3. Writes `SITE_ADDRESS` and `PUBLIC_URL` into `.env` if you passed a domain.
4. Builds the images and starts the stack.
5. Waits for the API's health check, then prints the address.

It is safe to run again. Databases, uploads and certificates live in named
Docker volumes and survive a rebuild.

## Updating

```bash
cd ClurkPdf
git pull
./scripts/deploy.sh
```

New migrations are applied by the server container as it starts.

## Day to day

```bash
docker compose -f docker-compose.prod.yml ps            # what is running
docker compose -f docker-compose.prod.yml logs -f        # follow all logs
docker compose -f docker-compose.prod.yml logs -f server # just the API
docker compose -f docker-compose.prod.yml restart server
docker compose -f docker-compose.prod.yml down           # stop (keeps data)
```

## Settings

`.env` in the repository root, created on the first deploy from
[`deploy/env.example`](./deploy/env.example). Run `./scripts/deploy.sh` after
changing it.

Keep that file. It holds the database password, and PostgreSQL only reads it
when the data volume is first created — deleting `.env` and redeploying
generates a new password that the existing volume will reject.

| Variable | Default | Notes |
| --- | --- | --- |
| `SITE_ADDRESS` | `:80` | A hostname here switches Caddy to HTTPS |
| `PUBLIC_URL` | `http://localhost` | Origin the browser uses |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Host ports Caddy binds |
| `POSTGRES_PASSWORD` | generated | Keep it alphanumeric; it goes into a URL |
| `MAX_FILE_SIZE` | `10485760` | Largest accepted upload, in bytes |
| `PAGE_DPI` | `150` | Render resolution; both containers are built against it |
| `OCR_LANGUAGE` | `eng` | e.g. `eng+deu` |
| `OCR_CONCURRENCY` | `2` | Regions recognised at once |

## Backups

Two things matter: the database and the uploaded files. Both are Docker
volumes, so a snapshot of the VPS covers them, but a smaller backup is easy:

```bash
# Database
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U invoice invoice_processor | gzip > invoices-$(date +%F).sql.gz

# Uploaded PDFs and rendered pages
docker run --rm -v clurkpdf_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

Restoring the database into a running stack:

```bash
gunzip -c invoices-2026-01-01.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U invoice invoice_processor
```

The two backups belong together: a database row points at files in the uploads
volume, and a document whose PDF is missing cannot be re-rendered.

## Troubleshooting

**`bind: address already in use`** — something already owns port 80, usually a
distribution nginx or Apache. Either remove it (`systemctl disable --now
nginx`) or set `HTTP_PORT` to something else in `.env`.

**The certificate does not arrive** — check the DNS record actually resolves to
this machine (`dig +short invoices.example.com`) and that both firewalls allow
80 and 443. `docker compose -f docker-compose.prod.yml logs web` shows the
Let's Encrypt exchange. Repeated failures hit a rate limit, so fix DNS before
retrying.

**OCR is killed part way through** — the container ran out of memory. Set
`OCR_CONCURRENCY=1` in `.env` and redeploy, or add swap:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**The API never reports healthy** — `docker compose -f docker-compose.prod.yml
logs server`. The usual cause is a migration failing against an older database
volume; the message names the migration.

**Uploads fail at the size limit** — `MAX_FILE_SIZE` is enforced by the server,
and Caddy passes bodies through without a limit of its own. Raise the variable
and redeploy.
