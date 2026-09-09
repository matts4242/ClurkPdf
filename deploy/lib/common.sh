#!/usr/bin/env bash
# Shared behaviour for the ClurkPdf deployment scripts.
#
# Sourced after lib/ui.sh by install.sh, update.sh, uninstall.sh and the
# `clurkpdf` command. Everything here is about the deployment itself — where it
# lives, who runs it, how to talk to its database — rather than about the
# terminal.
#
# The installer writes /etc/clurkpdf/install.conf; every other script reads it,
# so none of them has to guess where the last install put things.

if [[ -n ${CLURK_COMMON_SOURCED:-} ]]; then
  return 0
fi
CLURK_COMMON_SOURCED=1

CONF_FILE=${CONF_FILE:-/etc/clurkpdf/install.conf}

have() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ $(id -u) -ne 0 ]]; then
    ui_err "${1:-This command} must run as root. Try: sudo $0 $*"
    exit 1
  fi
}

# Load the record the installer left behind. Every caller needs APP_DIR and
# SERVICE_NAME at minimum, so a missing file is fatal rather than a warning.
load_install_conf() {
  if [[ ! -r $CONF_FILE ]]; then
    ui_err "No install was found (${CONF_FILE} is missing)."
    ui_dim '    Run deploy/install.sh first.'
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$CONF_FILE"
  : "${APP_DIR:?install.conf is missing APP_DIR}"
  : "${DATA_DIR:?install.conf is missing DATA_DIR}"
  : "${APP_USER:?install.conf is missing APP_USER}"
  : "${SERVICE_NAME:?install.conf is missing SERVICE_NAME}"
  : "${API_PORT:=3001}"
}

# git reset --hard and rm -rf both rewrite the very file bash is still reading,
# and bash reads a script lazily. Re-exec from a private copy so the script on
# disk can change underneath us without corrupting the run.
reexec_from_copy() {
  local self=${BASH_SOURCE[1]:-}
  [[ ${CLURK_REEXEC:-0} == 1 ]] && return 0
  [[ -n $self && -f $self ]] || return 0

  local copy
  copy=$(mktemp /tmp/clurkpdf-run.XXXXXX)
  cat "$self" >"$copy"
  chmod 0700 "$copy"
  export CLURK_REEXEC=1 CLURK_REEXEC_COPY=$copy
  exec bash "$copy" "$@"
}

clean_reexec_copy() {
  if [[ -n ${CLURK_REEXEC_COPY:-} && -f ${CLURK_REEXEC_COPY} ]]; then
    rm -f "$CLURK_REEXEC_COPY"
  fi
  return 0
}

# --------------------------------------------------------------------------
# Running things as the service account
# --------------------------------------------------------------------------

# NODE_ENV is deliberately cleared: npm skips devDependencies when it is
# `production`, and TypeScript and Vite both live there. The npm cache and the
# fontconfig cache are pointed at the data directory, which is the only place
# the service account is allowed to write.
as_app() {
  runuser -u "$APP_USER" -- env -u NODE_ENV \
    HOME="$APP_DIR" \
    PATH="$PATH" \
    XDG_CACHE_HOME="$DATA_DIR/cache" \
    npm_config_cache="$DATA_DIR/npm" \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false \
    CI=1 \
    "$@"
}

# npm, as the service account, from the repository root. The subshell keeps the
# directory change out of the caller's own state.
app_npm() {
  ( cd "$APP_DIR" && as_app npm "$@" )
}

install_dependencies() {
  # No --omit=optional here: @napi-rs/canvas and Rollup both ship their
  # platform binaries as optional dependencies, and the build needs them.
  if ! app_npm ci --no-audit --no-fund; then
    echo 'npm ci failed; falling back to npm install' >&2
    app_npm install --no-audit --no-fund
  fi
}

# The client bakes its API origin in at build time. If client/.env.production
# were not picked up, the bundle would quietly point at localhost:3001 and
# every request from a browser would fail — so check rather than hope.
verify_bundle() {
  local dist="$APP_DIR/client/dist"
  if [[ ! -f "$dist/index.html" ]]; then
    echo "No bundle was produced at ${dist}" >&2
    return 1
  fi

  # Only the emitted javascript. The source map beside it legitimately contains
  # the original `http://localhost:3001` default from src/api/client.ts, so a
  # recursive grep over the whole directory would condemn every correct build.
  local -a scripts=()
  mapfile -t scripts < <(find "$dist/assets" -maxdepth 1 -name '*.js' 2>/dev/null)
  if [[ ${#scripts[@]} -eq 0 ]]; then
    echo "No javascript was emitted into ${dist}/assets" >&2
    return 1
  fi
  if grep -qs 'localhost:3001' "${scripts[@]}"; then
    echo 'The built bundle still points at localhost:3001.' >&2
    echo 'client/.env.production was not applied; the app would not work in a browser.' >&2
    return 1
  fi
  return 0
}

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

# psql as the postgres superuser, with errors fatal rather than warnings.
psql_admin() {
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -Atq -c "$1"
}

# The connection string the service itself uses, read back out of its .env.
app_database_url() {
  local line
  line=$(grep -m1 '^DATABASE_URL=' "$APP_DIR/server/.env" 2>/dev/null || true)
  line=${line#DATABASE_URL=}
  line=${line%\"}
  line=${line#\"}
  printf '%s' "$line"
}

# Prisma's connection string carries parameters libpq has never heard of —
# ?schema= above all — and psql refuses the whole URL when it meets one. Strip
# exactly those, and leave everything else (sslmode and friends) alone.
libpq_url() {
  local url=$1
  url=$(printf '%s' "$url" | sed -E \
    -e 's/([?&])(schema|connection_limit|pool_timeout|pgbouncer|socket_timeout)=[^&]*/\1/g' \
    -e 's/[?&]+$//' -e 's/\?&+/?/' -e 's/&&+/\&/g')
  printf '%s' "$url"
}

# psql and pg_dump against the application's own database, as the invoking
# user. The local-install case goes through the postgres superuser instead; see
# the callers.
psql_app() {
  psql "$(libpq_url "$(app_database_url)")" "$@"
}

pg_dump_app() {
  pg_dump --no-owner "$(libpq_url "$(app_database_url)")"
}

# --------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------

service_active() { systemctl is-active --quiet "$SERVICE_NAME"; }

# Where a browser should go. Certbot rewrites the nginx site when it installs a
# certificate, so the site file is the honest answer to "http or https?" — more
# so than anything the installer could have recorded up front.
app_url() {
  local scheme='http'
  if grep -qs 'listen.*443' \
      /etc/nginx/sites-available/clurkpdf /etc/nginx/conf.d/clurkpdf.conf 2>/dev/null; then
    scheme='https'
  fi
  printf '%s://%s/' "$scheme" "${SERVE_HOST:-${DOMAIN:-localhost}}"
}

# Poll the health endpoint until the API answers, giving up either after the
# timeout or as soon as the unit dies — whichever happens first.
wait_for_health() {
  local attempts=${1:-30} i
  for ((i = 0; i < attempts; i++)); do
    if curl -fsS -m 3 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! service_active; then
      echo "The ${SERVICE_NAME} service stopped. Recent journal:" >&2
      journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "The API did not answer on port ${API_PORT} in time." >&2
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
  return 1
}
