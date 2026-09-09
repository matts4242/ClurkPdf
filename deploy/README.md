# Deploying to a VPS

One command on a fresh server:

```bash
curl -fsSL https://raw.githubusercontent.com/matts4242/ClurkPdf/main/deploy/install.sh | sudo bash
```

The installer asks a handful of questions, shows you what it is about to do,
and then does it. Ten minutes later the app is running behind nginx on port 80
— with a Let's Encrypt certificate if you gave it a domain.

```
   ██████╗██╗     ██╗   ██╗██████╗ ██╗  ██╗██████╗ ██████╗ ███████╗
  ██╔════╝██║     ██║   ██║██╔══██╗██║ ██╔╝██╔══██╗██╔══██╗██╔════╝
  ██║     ██║     ██║   ██║██████╔╝█████╔╝ ██████╔╝██║  ██║█████╗
  ██║     ██║     ██║   ██║██╔══██╗██╔═██╗ ██╔═══╝ ██║  ██║██╔══╝
  ╚██████╗███████╗╚██████╔╝██║  ██║██║  ██╗██║     ██████╔╝██║
   ╚═════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═════╝ ╚═╝
  Intelligent Invoice Batch Processor · installer 1.0.0

  ✔ ▕████████████████░░░░░░░░▏  70%  Installing the systemd service     1s
  ⠹ ▕██████████████████░░░░░░▏  75%  Configuring the nginx proxy        3s
```

## Requirements

| | |
| --- | --- |
| Operating system | Ubuntu 22.04+, Debian 11+, Rocky/Alma 9, or Fedora |
| Memory | 1GB works (a swap file is offered), 2GB is comfortable |
| Disk | 3GB free |
| Access | root, or a user with `sudo` |
| Init system | systemd |

Nothing else needs to be installed first. Node.js, PostgreSQL, nginx and
certbot are all installed by the script if they are missing.

Point the domain's A record at the server **before** running the installer if
you want a certificate; Let's Encrypt validates over port 80 and cannot issue
one for a name that does not resolve yet. The installer checks and warns.

## What it does

1. Checks the OS, architecture, memory, disk and network, and offers a 2GB swap
   file when memory is tight — the Vite build is the step that gets killed
   otherwise.
2. Installs Node.js 22 from NodeSource. `pdfjs-dist` requires 22.13 or newer,
   so a distribution's Node 18 or 20 will not do.
3. Installs PostgreSQL, then creates the `clurkpdf` database and role with a
   generated password. Or skips all of that when you point it at a database you
   already have.
4. Creates the `clurkpdf` system account. The app never runs as root.
5. Clones the repository into `/opt/clurkpdf`, installs dependencies, and
   builds both packages.
6. Writes `server/.env` and `client/.env.production`, then checks that the
   built bundle really did pick the latter up.
7. Applies the Prisma migrations.
8. Installs a hardened systemd unit and enables it at boot.
9. Configures nginx: the compiled bundle as static files, `/api` and `/uploads`
   proxied to the API.
10. Requests a certificate with certbot, when a domain was given.
11. Opens SSH, HTTP and HTTPS in ufw or firewalld.
12. Starts the service and waits for `/api/health` to answer.

Anything the commands print goes to `/var/log/clurkpdf-install.log`, and the
last 25 lines are shown on screen if a step fails.

## Where things end up

| Path | What |
| --- | --- |
| `/opt/clurkpdf` | The checkout, `node_modules`, and both builds |
| `/opt/clurkpdf/server/.env` | Every setting the service reads |
| `/var/lib/clurkpdf/uploads` | Uploaded PDFs and rendered page images |
| `/var/lib/clurkpdf/tesseract` | Tesseract language data (~5MB, fetched once) |
| `/var/lib/clurkpdf/backups` | Database dumps taken before each update |
| `/etc/clurkpdf/install.conf` | What the installer chose, for the other scripts |
| `/etc/systemd/system/clurkpdf.service` | The unit |
| `/usr/local/bin/clurkpdf` | The management command |

Data lives outside the application directory on purpose: re-running the
installer replaces `/opt/clurkpdf` wholesale and never touches uploads.

## Managing it afterwards

```bash
clurkpdf status          # service state, revision, document count, disk use
clurkpdf doctor          # check every moving part and say what is wrong
clurkpdf logs -f         # follow the journal
clurkpdf restart
sudo clurkpdf update     # pull, rebuild, migrate, restart
sudo clurkpdf backup     # dump the database
sudo clurkpdf config     # show the running settings, password redacted
sudo clurkpdf db         # psql shell on the application database
sudo clurkpdf uninstall
```

`update` dumps the database before it migrates, keeps the five most recent
dumps, and refuses to rebuild when the branch has not moved unless you pass
`--force`. If a step fails it tells you the revision you were on, so you can
get back to it.

## Unattended installs

Every question has a flag and an environment variable, so the whole thing can
run from a provisioning script:

```bash
curl -fsSL https://raw.githubusercontent.com/matts4242/ClurkPdf/main/deploy/install.sh \
  | sudo bash -s -- --yes \
      --domain invoices.example.com \
      --email ops@example.com \
      --max-upload 25
```

Against a managed database, with no local PostgreSQL:

```bash
sudo ./deploy/install.sh --yes \
  --database-url 'postgresql://user:password@db.internal:5432/clurkpdf?schema=public'
```

`--dry-run` prints every step, including the exact commands, without touching
the machine. It is the fastest way to see what an install would do:

```bash
./deploy/install.sh --dry-run --yes --domain invoices.example.com
```

Run `./deploy/install.sh --help` for the full list.

## Installing from a checkout

The installer notices when it is being run from a clone and installs that
working tree instead of fetching one — which is also how you install a branch
that is not on GitHub yet, or install without the script being able to reach
raw.githubusercontent.com:

```bash
git clone https://github.com/matts4242/ClurkPdf.git
cd ClurkPdf
sudo ./deploy/install.sh
```

For a private repository this is the only way: `curl | bash` cannot
authenticate, and the installer says so rather than failing obscurely.

## Configuration afterwards

Everything is in `/opt/clurkpdf/server/.env`, which is the same file the
[main README](../README.md#configuration) documents. Edit it and restart:

```bash
sudo nano /opt/clurkpdf/server/.env
sudo systemctl restart clurkpdf
```

Two settings are worth knowing about:

- **`MAX_FILE_SIZE`** has to agree with nginx. The installer sets
  `client_max_body_size` to your chosen limit plus 2MB; raising one without the
  other gets you a 413 from nginx before the API ever sees the upload.
- **`PAGE_DPI`** has to agree with `VITE_PAGE_DPI` in
  `/opt/clurkpdf/client/.env.production`, or 100% zoom shows pages at the wrong
  size. Changing it means rebuilding the client: `sudo clurkpdf update --force`.

`CLIENT_ORIGIN` matters less than it looks: nginx serves the bundle from the
same origin as the API, so the browser makes same-origin requests and CORS
never comes into it. It is there for a client hosted somewhere else.

## Notes on the choices made

- **The bundle uses relative URLs.** `VITE_SERVER_ORIGIN` is written empty,
  which makes every request in the client relative — so the same build works
  whether you reach the server by domain name or by IP, over http or https, and
  keeps working after certbot adds TLS. The installer greps the built assets
  for `localhost:3001` afterwards and fails the install if it finds it, because
  a bundle that was built without its env file is broken in a way that only
  shows up in a browser.
- **`/uploads` is proxied, not served from disk.** nginx could serve
  `/var/lib/clurkpdf/uploads` directly and faster, but the API deliberately
  answers 403 for everything in that tree except rendered page images and
  thumbnails. Serving the directory would hand out the original PDFs alongside
  them.
- **The systemd unit is locked down.** `ProtectSystem=strict` with
  `ReadWritePaths=/var/lib/clurkpdf` means the service can write to its data
  directory and nowhere else — not even to its own code. `PrivateTmp`,
  `NoNewPrivileges` and the `Protect*` family are all on.
- **The distribution's default nginx site is removed** so the app can answer on
  port 80 by IP as well as by name. `uninstall.sh` puts it back. On RHEL-family
  systems, where the default server lives in `nginx.conf` itself, the installer
  edits out its `default_server` and keeps a `.clurkpdf.bak` copy.
- **PostgreSQL, Node.js and nginx survive an uninstall.** They are ordinary
  system packages that something else on the machine may depend on.
- **Re-running the installer is an upgrade.** The role's password is reset, the
  source is re-fetched, everything is rebuilt, and uploads are untouched.

## When something goes wrong

```bash
clurkpdf doctor                     # start here
journalctl -u clurkpdf -n 50        # what the service said
sudo less /var/log/clurkpdf-install.log
sudo nginx -t
```

**The install failed partway.** It is safe to run again; every step is
idempotent. The failure box names the step and shows the tail of the log.

**The page loads but nothing works.** Almost always a bundle built without its
env file — `sudo clurkpdf update --force` rebuilds it. `clurkpdf doctor` says
so explicitly when the bundle is missing entirely.

**The certificate request failed.** The app is still serving over http; the
install does not abort over TLS. Fix the DNS record and run
`sudo certbot --nginx -d your.domain`.

**An upload gets a 413.** nginx's `client_max_body_size` is below
`MAX_FILE_SIZE`. See the two settings noted above.

**OCR is slow or the process gets killed.** Each region is a WASM instance.
Lower `OCR_CONCURRENCY` on a small server; the installer picks a value from the
core count, but memory is usually the real constraint.

## The scripts

| File | |
| --- | --- |
| `install.sh` | The installer. Self-contained enough to be piped to bash. |
| `update.sh` | Pull, rebuild, migrate, restart. `clurkpdf update` runs it. |
| `uninstall.sh` | Remove the deployment, with separate questions about data. |
| `clurkpdf` | The management command, symlinked into `/usr/local/bin`. |
| `lib/ui.sh` | Logo, progress bars, prompts. Degrades to ASCII and to no colour. |
| `lib/common.sh` | Where the deployment lives, who runs it, how to reach its database. |

`update.sh` and `uninstall.sh` both re-exec themselves from a private copy in
`/tmp` before they start, because both rewrite the directory they are running
from and bash reads a script as it goes.
