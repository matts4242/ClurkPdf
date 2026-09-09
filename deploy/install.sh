#!/usr/bin/env bash
#
#   ClurkPdf — one-command VPS installer
#
#   curl -fsSL https://raw.githubusercontent.com/matts4242/ClurkPdf/main/deploy/install.sh | sudo bash
#
# Takes a bare Ubuntu, Debian, Rocky, Alma or Fedora server and leaves behind a
# running Intelligent Invoice Batch Processor: Node.js 22, PostgreSQL, the
# built application under a dedicated service account, an nginx reverse proxy,
# a systemd unit, an optional Let's Encrypt certificate, and a firewall.
#
# The script asks its questions first and does its work afterwards, so nothing
# on the machine changes until the plan has been shown and confirmed.
# Re-running it over an existing install is safe: every step is written to be
# idempotent, and an existing deployment is updated in place.
#
# Run with --help for the full list of flags, or --dry-run to watch the whole
# thing execute without touching the machine.

set -Eeuo pipefail

INSTALLER_VERSION='1.0.0'

# --------------------------------------------------------------------------
# Defaults. Every one of these can be overridden by a flag or an environment
# variable, which is what makes an unattended install possible.
# --------------------------------------------------------------------------

APP_NAME='clurkpdf'
APP_TITLE='ClurkPdf'
APP_SUBTITLE='Intelligent Invoice Batch Processor'
APP_USER=${CLURK_USER:-clurkpdf}
APP_DIR=${CLURK_DIR:-/opt/clurkpdf}
DATA_DIR=${CLURK_DATA_DIR:-/var/lib/clurkpdf}
CONF_DIR='/etc/clurkpdf'
SERVICE_NAME='clurkpdf'

REPO_URL=${CLURK_REPO:-https://github.com/matts4242/ClurkPdf.git}
REPO_BRANCH=${CLURK_BRANCH:-main}

# pdfjs-dist sets the floor; Node 20 cannot run this project at all.
NODE_MAJOR=22
NODE_MIN_VERSION='22.13.0'

# Answers collected during the interview.
DOMAIN=${CLURK_DOMAIN:-}
TLS_EMAIL=${CLURK_EMAIL:-}
API_PORT=${CLURK_PORT:-3001}
MAX_UPLOAD_MB=${CLURK_MAX_UPLOAD_MB:-10}
PAGE_DPI=${CLURK_PAGE_DPI:-150}
OCR_LANGUAGE=${CLURK_OCR_LANGUAGE:-eng}
OCR_CONCURRENCY=${CLURK_OCR_CONCURRENCY:-}
DATABASE_URL=${CLURK_DATABASE_URL:-}
DB_NAME=${CLURK_DB_NAME:-clurkpdf}
DB_USER=${CLURK_DB_USER:-clurkpdf}
DB_PASSWORD=''

# Behaviour switches.
ASSUME_YES=0
DRY_RUN=0
DB_LOCAL=1
DO_TLS=0
DO_NGINX=1
DO_FIREWALL=1
DO_SWAP=0
WANT_COLOR=1
WANT_ASCII=0
NO_TLS_FORCED=0

# Filled in by detection.
OS_ID=''; OS_VERSION=''; OS_PRETTY=''; PKG=''; DNF=''
NODE_BIN=''
LOCAL_SOURCE=''
PUBLIC_IP=''
SERVE_HOST=''
TLS_FAILED=0
WORK_DIR=''
ORIGINAL_ARGS=''

UI_LOG=${CLURK_LOG:-/var/log/clurkpdf-install.log}

# --------------------------------------------------------------------------
# Bootstrap output
#
# Everything up to the point where lib/ui.sh is loaded prints plainly: the UI
# library may still be one curl away.
# --------------------------------------------------------------------------

boot_say()  { printf '  %s\n' "$*"; }
boot_fail() { printf '\n  [x] %s\n\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
${APP_TITLE} installer ${INSTALLER_VERSION} — ${APP_SUBTITLE}

USAGE
  curl -fsSL <raw-url>/deploy/install.sh | sudo bash
  curl -fsSL <raw-url>/deploy/install.sh | sudo bash -s -- --yes --domain invoices.example.com
  sudo ./deploy/install.sh [options]          (from a checkout)

OPTIONS
  -y, --yes                 Accept every default; never prompt. Combined with
                            the flags and environment below this is a complete
                            unattended install.
      --domain <name>       Domain the app is served on. Blank serves on the IP.
      --email <address>     Contact address for the Let's Encrypt certificate.
      --tls / --no-tls      Request a certificate, or do not. Defaults to on
                            when a domain is given and off otherwise.
      --port <n>            Port the API listens on behind nginx (default 3001).
      --max-upload <mb>     Largest accepted PDF, in megabytes (default 10).
      --ocr-language <code> Tesseract language, e.g. eng or eng+deu.
      --database-url <url>  Use an existing PostgreSQL instead of installing one.
      --dir <path>          Install directory (default /opt/clurkpdf).
      --data-dir <path>     Uploads and OCR cache (default /var/lib/clurkpdf).
      --repo <url>          Source repository to install from.
      --branch <name>       Branch to install (default main).
      --no-nginx            Skip the reverse proxy; expose the API port directly.
      --no-firewall         Do not touch ufw or firewalld.
      --no-color            Disable colour.
      --ascii               Force ASCII drawing characters.
      --dry-run             Show every step without changing the machine.
      --log <path>          Where the install log is written.
  -h, --help                This text.
  -V, --version             Print the installer version.

ENVIRONMENT
  CLURK_DOMAIN, CLURK_EMAIL, CLURK_PORT, CLURK_DATABASE_URL, CLURK_DIR,
  CLURK_DATA_DIR, CLURK_REPO, CLURK_BRANCH, CLURK_MAX_UPLOAD_MB,
  CLURK_OCR_LANGUAGE, CLURK_OCR_CONCURRENCY, CLURK_LOG

  Each is the default for the matching flag, so an unattended install can be
  driven entirely from the environment.

EXAMPLES
  # Interactive, the usual case
  curl -fsSL <raw-url>/deploy/install.sh | sudo bash

  # Unattended, with a domain and a certificate
  curl -fsSL <raw-url>/deploy/install.sh | sudo bash -s -- \\
      --yes --domain invoices.example.com --email ops@example.com

  # Against a managed database, no local PostgreSQL
  sudo ./deploy/install.sh --yes --database-url 'postgresql://u:p@db.host:5432/clurkpdf'
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      -y|--yes|--non-interactive) ASSUME_YES=1 ;;
      --domain)         DOMAIN=${2:-}; shift ;;
      --email)          TLS_EMAIL=${2:-}; shift ;;
      --tls)            DO_TLS=1 ;;
      --no-tls)         DO_TLS=0; NO_TLS_FORCED=1 ;;
      --port)           API_PORT=${2:-}; shift ;;
      --max-upload)     MAX_UPLOAD_MB=${2:-}; shift ;;
      --ocr-language)   OCR_LANGUAGE=${2:-}; shift ;;
      --database-url)   DATABASE_URL=${2:-}; DB_LOCAL=0; shift ;;
      --dir)            APP_DIR=${2:-}; shift ;;
      --data-dir)       DATA_DIR=${2:-}; shift ;;
      --repo)           REPO_URL=${2:-}; shift ;;
      --branch)         REPO_BRANCH=${2:-}; shift ;;
      --no-nginx)       DO_NGINX=0 ;;
      --no-firewall)    DO_FIREWALL=0 ;;
      --no-color)       WANT_COLOR=0 ;;
      --ascii)          WANT_ASCII=1 ;;
      --dry-run)        DRY_RUN=1 ;;
      --log)            UI_LOG=${2:-}; shift ;;
      -h|--help)        usage; exit 0 ;;
      -V|--version)     printf '%s\n' "$INSTALLER_VERSION"; exit 0 ;;
      *) boot_fail "Unknown option: $1 (try --help)" ;;
    esac
    shift
  done
}

# --------------------------------------------------------------------------
# Platform detection
# --------------------------------------------------------------------------

detect_os() {
  [[ -r /etc/os-release ]] || boot_fail 'Cannot read /etc/os-release; this OS is not supported.'
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID=${ID:-unknown}
  OS_VERSION=${VERSION_ID:-}
  OS_PRETTY=${PRETTY_NAME:-$OS_ID}

  case $OS_ID in
    ubuntu|debian|raspbian|linuxmint|pop) PKG='apt' ;;
    fedora|rhel|centos|rocky|almalinux|ol) PKG='dnf' ;;
    *)
      case ${ID_LIKE:-} in
        *debian*)        PKG='apt' ;;
        *rhel*|*fedora*) PKG='dnf' ;;
        *) boot_fail "Unsupported distribution: ${OS_PRETTY}. Ubuntu, Debian, Rocky, Alma and Fedora are supported." ;;
      esac
      ;;
  esac

  if [[ $PKG == dnf ]]; then
    DNF=$(command -v dnf || command -v yum || true)
    [[ -n $DNF ]] || boot_fail 'Neither dnf nor yum is available.'
  fi
}

# --------------------------------------------------------------------------
# Package manager wrappers
# --------------------------------------------------------------------------

pkg_refresh() {
  case $PKG in
    apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq ;;
    dnf) "$DNF" -y makecache ;;
  esac
}

pkg_install() {
  case $PKG in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" ;;
    dnf) "$DNF" -y install "$@" ;;
  esac
}

pkg_present() {
  case $PKG in
    apt) dpkg -s "$1" >/dev/null 2>&1 ;;
    dnf) rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}

# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

# True when $1 is at least $2, comparing dotted versions.
version_ge() {
  [[ $1 == "$2" ]] && return 0
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

# A hex string from the kernel's entropy pool. Avoids depending on openssl, and
# the alphabet is safe to drop into a connection string or an SQL literal
# without raising any quoting question.
random_hex() {
  local bytes=${1:-24}
  od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
}

systemd_running() { [[ -d /run/systemd/system ]]; }

# as_app, app_npm, psql_admin, install_dependencies, verify_bundle and
# wait_for_health come from lib/common.sh, which update.sh and the clurkpdf
# command share.

# --------------------------------------------------------------------------
# Bootstrap: obtain the UI library, then hand over to it
# --------------------------------------------------------------------------

# Locate a checkout around this script, so running deploy/install.sh from a
# clone installs that clone instead of fetching a fresh one.
find_local_source() {
  local self=${BASH_SOURCE[0]:-}
  [[ -n $self && -f $self ]] || return 0
  local dir
  dir=$(cd -- "$(dirname -- "$self")" && pwd) || return 0
  if [[ -f "$dir/lib/ui.sh" && -f "$dir/../package.json" ]]; then
    LOCAL_SOURCE=$(cd -- "$dir/.." && pwd)
  fi
}

# The installer's own libraries. From a checkout they sit next to this script;
# piped from curl they have to be fetched first, which is the only work that
# happens before the logo appears.
load_libs() {
  if [[ -n $LOCAL_SOURCE ]]; then
    # shellcheck source=lib/ui.sh
    . "$LOCAL_SOURCE/deploy/lib/ui.sh"
    # shellcheck source=lib/common.sh
    . "$LOCAL_SOURCE/deploy/lib/common.sh"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    boot_say 'Installing curl...'
    if [[ $DRY_RUN != 1 ]]; then
      pkg_refresh >/dev/null 2>&1 || true
      pkg_install curl ca-certificates >/dev/null 2>&1 || true
    fi
    command -v curl >/dev/null 2>&1 || boot_fail 'curl is required and could not be installed.'
  fi

  local base="${REPO_URL%.git}"
  base=${base/github.com/raw.githubusercontent.com}
  base="${base}/${REPO_BRANCH}/deploy/lib"

  WORK_DIR=$(mktemp -d /tmp/clurkpdf-install.XXXXXX)
  boot_say 'Fetching the installer libraries...'
  local lib
  for lib in ui.sh common.sh; do
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "${WORK_DIR}/${lib}" "${base}/${lib}"; then
      boot_fail "Could not download ${base}/${lib}
      If the repository is private, clone it first and run deploy/install.sh
      from the checkout instead."
    fi
  done
  # shellcheck source=lib/ui.sh
  . "${WORK_DIR}/ui.sh"
  # shellcheck source=lib/common.sh
  . "${WORK_DIR}/common.sh"
}

open_log() {
  local dir
  dir=$(dirname -- "$UI_LOG")
  if ! mkdir -p "$dir" 2>/dev/null || ! touch "$UI_LOG" 2>/dev/null; then
    UI_LOG='/tmp/clurkpdf-install.log'
    touch "$UI_LOG" 2>/dev/null || UI_LOG=/dev/null
  fi
  # The log carries the generated database password in the .env it echoes.
  [[ $UI_LOG == /dev/null ]] || chmod 600 "$UI_LOG" 2>/dev/null || true
  ui_log "==== ${APP_TITLE} installer ${INSTALLER_VERSION} ===="
  ui_log "args: ${ORIGINAL_ARGS}"
  ui_log "os: ${OS_PRETTY} (${OS_ID} ${OS_VERSION}) pkg=${PKG} arch=$(uname -m)"
}

# --------------------------------------------------------------------------
# Failure handling
# --------------------------------------------------------------------------

on_error() {
  local rc=$?
  ui_spin_abort
  ui_log "FAILED (status ${rc}) during: ${UI_CURRENT_STEP:-startup}"
  ui_box "$C_ERR" 'Install failed' \
    "Step: ${UI_CURRENT_STEP:-startup}" \
    "Exit status ${rc}. Nothing further has been changed." \
    '' \
    "Full output:  ${UI_LOG}" \
    "Service logs: journalctl -u ${SERVICE_NAME} -n 50"
  ui_log_tail 25
  exit "$rc"
}

on_interrupt() {
  ui_spin_abort
  printf '\n'
  ui_warn 'Interrupted. Nothing further will be changed.'
  ui_dim "Partial progress is recorded in ${UI_LOG}"
  exit 130
}

on_exit() {
  ui_cursor_show
  if [[ -n $WORK_DIR && -d $WORK_DIR ]]; then
    rm -rf "$WORK_DIR"
  fi
  return 0
}

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------

preflight() {
  ui_section 'Checking this machine'

  if [[ $(id -u) -ne 0 ]]; then
    if [[ $DRY_RUN == 1 ]]; then
      ui_warn 'Not running as root. A dry run is fine; a real install needs sudo.'
    else
      ui_err 'This installer must run as root.'
      ui_dim '    curl -fsSL <raw-url>/deploy/install.sh | sudo bash'
      exit 1
    fi
  fi

  ui_ok "Operating system   ${OS_PRETTY}"

  local arch
  arch=$(uname -m)
  case $arch in
    x86_64|amd64|aarch64|arm64) ui_ok "Architecture       ${arch}" ;;
    *) ui_warn "Architecture ${arch} is untested; prebuilt npm binaries may be missing." ;;
  esac

  if systemd_running; then
    ui_ok 'Service manager    systemd'
  else
    ui_err 'systemd is not running. This installer manages the app as a systemd service.'
    ui_dim '    OpenVZ and some minimal LXC images cannot run it.'
    [[ $DRY_RUN == 1 ]] || exit 1
  fi

  local mem_mb swap_kb
  mem_mb=$(awk '/MemTotal/ {printf "%d", $2 / 1024}' /proc/meminfo)
  if [[ ${mem_mb:-0} -ge 1800 ]]; then
    ui_ok "Memory             ${mem_mb}MB"
  else
    ui_warn "Memory ${mem_mb}MB is below the 2GB the browser bundle build wants."
    swap_kb=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
    if [[ ${swap_kb:-0} -lt 262144 ]]; then
      DO_SWAP=1
      ui_dim '    A 2GB swap file will be offered, so the Vite build is not killed.'
    fi
  fi

  local free_mb parent
  parent=$(dirname -- "$APP_DIR")
  [[ -d $parent ]] || parent='/'
  free_mb=$(df -Pm "$parent" 2>/dev/null | awk 'NR==2 {print $4}' || true)
  if [[ ${free_mb:-0} -ge 3000 ]]; then
    ui_ok "Free disk          ${free_mb}MB"
  elif [[ ${free_mb:-0} -ge 1500 ]]; then
    ui_warn "Only ${free_mb}MB free. node_modules plus PostgreSQL need roughly 2GB."
  else
    ui_err "Only ${free_mb:-0}MB free on ${parent}. At least 1.5GB is required."
    [[ $DRY_RUN == 1 ]] || exit 1
  fi

  local cores
  cores=$(nproc 2>/dev/null || echo 1)
  ui_ok "CPU cores          ${cores}"
  # Each OCR worker holds its own WASM instance, so core count is the ceiling.
  if [[ -z $OCR_CONCURRENCY ]]; then
    OCR_CONCURRENCY=$(( cores >= 8 ? 4 : (cores <= 1 ? 1 : cores / 2 + 1) ))
  fi

  if curl -fsS -m 8 -o /dev/null https://registry.npmjs.org/ 2>/dev/null; then
    ui_ok 'Network            registry.npmjs.org reachable'
  else
    ui_warn 'Could not reach registry.npmjs.org. The dependency install needs it.'
  fi

  PUBLIC_IP=$(curl -fsS -m 6 https://api.ipify.org 2>/dev/null || true)
  [[ -n $PUBLIC_IP ]] || PUBLIC_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true)
  [[ -n $PUBLIC_IP ]] || PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  [[ -z $PUBLIC_IP ]] || ui_ok "Public address     ${PUBLIC_IP}"

  if [[ -d "$APP_DIR/.git" || -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    ui_info "An existing install was found; it will be updated in place."
  fi
}

# --------------------------------------------------------------------------
# Interview
# --------------------------------------------------------------------------

interview() {
  ui_section 'Configuration'
  if [[ $UI_INTERACTIVE != 1 && $ASSUME_YES != 1 ]]; then
    ui_warn 'No terminal is attached; the defaults below will be used.'
  fi

  ui_ask DOMAIN 'Domain name for this server (blank to serve on the IP address)' "$DOMAIN"
  DOMAIN=${DOMAIN// /}

  if [[ -n $DOMAIN ]]; then
    SERVE_HOST=$DOMAIN
    check_dns
    if [[ $NO_TLS_FORCED != 1 ]] && ui_confirm "Request a free Let's Encrypt certificate for ${DOMAIN}?" yes; then
      DO_TLS=1
      while :; do
        ui_ask TLS_EMAIL 'Contact address for certificate expiry notices' "$TLS_EMAIL"
        [[ $TLS_EMAIL == *@*.* ]] && break
        if [[ $ASSUME_YES == 1 || $UI_INTERACTIVE != 1 ]]; then
          ui_warn 'No valid email address given; skipping the certificate.'
          DO_TLS=0
          break
        fi
        ui_warn 'That does not look like an email address.'
      done
    else
      DO_TLS=0
    fi
  else
    SERVE_HOST=${PUBLIC_IP:-localhost}
    DO_TLS=0
    ui_dim "    The app will answer on http://${SERVE_HOST}/"
  fi

  # The first option is what an unattended run picks, so the order has to
  # follow what --database-url already said. Otherwise `--yes --database-url`
  # would quietly install a local PostgreSQL and ignore the string it was given.
  local db_choice
  if [[ $DB_LOCAL == 1 ]]; then
    ui_menu db_choice 'Where should the database live?' \
      'local:Install PostgreSQL on this server (recommended)' \
      'external:Use a PostgreSQL I already have'
  else
    ui_menu db_choice 'Where should the database live?' \
      'external:Use the PostgreSQL given on the command line' \
      'local:Install PostgreSQL on this server instead'
  fi
  if [[ $db_choice == external ]]; then
    DB_LOCAL=0
    while :; do
      ui_ask DATABASE_URL 'PostgreSQL connection string' "$DATABASE_URL"
      [[ $DATABASE_URL == postgres*://* ]] && break
      if [[ $ASSUME_YES == 1 || $UI_INTERACTIVE != 1 ]]; then
        ui_err 'A DATABASE_URL is required when an external database is chosen.'
        exit 1
      fi
      ui_warn 'Expected something like postgresql://user:password@host:5432/dbname'
    done
  else
    DB_LOCAL=1
  fi

  ui_ask API_PORT 'Port for the API to listen on (behind nginx)' "$API_PORT"
  ui_ask MAX_UPLOAD_MB 'Largest accepted PDF, in megabytes' "$MAX_UPLOAD_MB"
  ui_ask OCR_LANGUAGE 'Tesseract language (eng, deu, eng+deu, ...)' "$OCR_LANGUAGE"

  if [[ $DO_FIREWALL == 1 ]] && ! ui_confirm 'Configure the firewall to allow SSH, HTTP and HTTPS?' yes; then
    DO_FIREWALL=0
  fi

  if [[ $DO_SWAP == 1 ]] && ! ui_confirm 'Add a 2GB swap file so the build does not run out of memory?' yes; then
    DO_SWAP=0
  fi

  validate_answers
}

validate_answers() {
  [[ $API_PORT =~ ^[0-9]+$ ]] && ((API_PORT > 0 && API_PORT < 65536)) \
    || ui_die "Invalid port: ${API_PORT}"
  [[ $MAX_UPLOAD_MB =~ ^[0-9]+$ ]] && ((MAX_UPLOAD_MB > 0)) \
    || ui_die "Invalid upload size: ${MAX_UPLOAD_MB}"
  [[ $OCR_LANGUAGE =~ ^[a-zA-Z_+]+$ ]] \
    || ui_die "Invalid Tesseract language: ${OCR_LANGUAGE}"
  if [[ -n $DOMAIN && ! $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]]; then
    ui_die "Invalid domain: ${DOMAIN}"
  fi
  if [[ $DB_LOCAL == 0 && -z $DATABASE_URL ]]; then
    ui_die 'An external database was chosen but no connection string was given.'
  fi
}

# A certificate request fails when the domain does not already point here, and
# it fails after nginx has been reconfigured. Better to say so now.
check_dns() {
  local resolved=''
  if have getent; then
    resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
  fi
  if [[ -z $resolved ]]; then
    ui_warn "${DOMAIN} does not resolve yet. Point an A record at ${PUBLIC_IP:-this server} before requesting a certificate."
  elif [[ -n $PUBLIC_IP && $resolved != "$PUBLIC_IP" ]]; then
    ui_warn "${DOMAIN} resolves to ${resolved}, but this server looks like ${PUBLIC_IP}."
  else
    ui_ok "${DOMAIN} resolves to this server"
  fi
}

# --------------------------------------------------------------------------
# The plan
# --------------------------------------------------------------------------

show_plan() {
  local db_line proxy_line scheme='http'
  [[ $DO_TLS == 1 ]] && scheme='https'

  if [[ $DB_LOCAL == 1 ]]; then
    db_line="PostgreSQL on this server, database '${DB_NAME}'"
  else
    db_line="External: $(printf '%s' "${DATABASE_URL%%\?*}" | sed -E 's#://[^@]*@#://***@#')"
  fi

  if [[ $DO_NGINX == 0 ]]; then
    proxy_line="none — the API is exposed directly on ${API_PORT}"
  elif [[ $DO_TLS == 1 ]]; then
    proxy_line="nginx on 80 and 443, Let's Encrypt certificate"
  else
    proxy_line='nginx on port 80'
  fi

  ui_box "$C_BRAND" 'Install plan' \
    "$(printf '%-18s %s' 'Address'         "${scheme}://${SERVE_HOST}/")" \
    "$(printf '%-18s %s' 'Application'     "$APP_DIR")" \
    "$(printf '%-18s %s' 'Uploads'         "${DATA_DIR}/uploads")" \
    "$(printf '%-18s %s' 'Service account' "$APP_USER")" \
    "$(printf '%-18s %s' 'Database'        "$db_line")" \
    "$(printf '%-18s %s' 'Reverse proxy'   "$proxy_line")" \
    "$(printf '%-18s %s' 'API port'        "$API_PORT")" \
    "$(printf '%-18s %s' 'Max upload'      "${MAX_UPLOAD_MB}MB")" \
    "$(printf '%-18s %s' 'OCR'             "${OCR_LANGUAGE}, ${OCR_CONCURRENCY} region(s) at a time")" \
    "$(printf '%-18s %s' 'Firewall'        "$(firewall_summary)")" \
    "$(printf '%-18s %s' 'Source'          "${REPO_BRANCH} of ${LOCAL_SOURCE:-$REPO_URL}")"

  if [[ $DRY_RUN == 1 ]]; then
    ui_warn 'Dry run: every step below is printed, nothing is executed.'
  elif ! ui_confirm 'Proceed with the install?' yes; then
    ui_info 'Nothing was changed.'
    exit 0
  fi
}

firewall_summary() {
  if [[ $DO_FIREWALL == 1 ]]; then
    printf 'allow SSH, HTTP, HTTPS'
  else
    printf 'left alone'
  fi
}

# Count the steps up front so the progress bar tells the truth.
plan_steps() {
  local total=15
  [[ $DO_SWAP == 1 ]]     && total=$((total + 1))
  [[ $DB_LOCAL == 1 ]]    && total=$((total + 2))
  [[ $DO_NGINX == 1 ]]    && total=$((total + 1))
  [[ $DO_TLS == 1 ]]      && total=$((total + 1))
  [[ $DO_FIREWALL == 1 ]] && total=$((total + 1))
  ui_steps_total "$total"
}

# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------

step_swap() {
  [[ $DO_SWAP == 1 ]] || return 0
  ui_run 'Adding a 2GB swap file' create_swap
}

create_swap() {
  if swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile; then
    return 0
  fi
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
}

step_base_packages() {
  ui_run 'Refreshing the package index' pkg_refresh

  local -a packages=(ca-certificates curl git tar gzip)
  case $PKG in
    # fontconfig and one base font: pdf.js is asked to use system fonts, and a
    # minimal server image often ships none at all.
    apt) packages+=(fontconfig fonts-dejavu-core) ;;
    dnf) packages+=(fontconfig dejavu-sans-fonts) ;;
  esac
  ui_run 'Installing base packages' pkg_install "${packages[@]}"
}

step_node() {
  if have node && version_ge "$(node -v 2>/dev/null | tr -d 'v')" "$NODE_MIN_VERSION"; then
    NODE_BIN=$(command -v node)
    ui_skip "Node.js $(node -v) already meets the ${NODE_MIN_VERSION} floor"
    return 0
  fi

  ui_run "Installing Node.js ${NODE_MAJOR}" install_node

  if [[ $DRY_RUN != 1 ]]; then
    have node || ui_die 'Node.js did not install.'
    version_ge "$(node -v | tr -d 'v')" "$NODE_MIN_VERSION" \
      || ui_die "Node $(node -v) is older than the required ${NODE_MIN_VERSION}."
  fi
  NODE_BIN=$(command -v node || echo /usr/bin/node)
}

install_node() {
  local setup="${WORK_DIR}/nodesource.sh"
  case $PKG in
    apt)
      curl -fsSL --retry 3 "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup"
      DEBIAN_FRONTEND=noninteractive bash "$setup"
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
      ;;
    dnf)
      curl -fsSL --retry 3 "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup"
      bash "$setup"
      "$DNF" -y install nodejs
      ;;
  esac
}

step_postgres() {
  [[ $DB_LOCAL == 1 ]] || return 0
  ui_run 'Installing PostgreSQL' install_postgres
  ui_run 'Creating the database and role' provision_database
}

install_postgres() {
  case $PKG in
    apt)
      pkg_install postgresql postgresql-contrib
      ;;
    dnf)
      # The stream default on RHEL 9 is older than the 14 this project needs.
      "$DNF" -qy module enable postgresql:16 >/dev/null 2>&1 || true
      pkg_install postgresql-server postgresql-contrib
      if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
        postgresql-setup --initdb
      fi
      ;;
  esac
  systemctl enable --now postgresql

  # A cold initdb takes a moment to start accepting connections.
  local i
  for i in $(seq 1 30); do
    if runuser -u postgres -- psql -c 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo 'PostgreSQL did not accept connections within 30 seconds.' >&2
  return 1
}

provision_database() {
  DB_PASSWORD=$(random_hex 24)

  # CREATE ROLE has no IF NOT EXISTS, so a re-run goes through a DO block. The
  # password is reset either way, which is what keeps .env and the database in
  # agreement when the installer runs a second time.
  psql_admin "DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
        CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
      ELSE
        ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}';
      END IF;
    END
  \$\$;"

  if [[ $(psql_admin "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'") != '1' ]]; then
    psql_admin "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
  fi
  # Prisma migrations create and drop objects in the public schema, so the role
  # needs ownership of it rather than plain connect rights.
  psql_admin "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER}"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -Atq -d "$DB_NAME" \
    -c "ALTER SCHEMA public OWNER TO ${DB_USER}"

  DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public"
}

step_account() {
  ui_run "Creating the ${APP_USER} service account" create_account
}

create_account() {
  local shell_bin
  for shell_bin in /usr/sbin/nologin /sbin/nologin /bin/false; do
    [[ -x $shell_bin ]] && break
  done

  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$APP_DIR" --shell "$shell_bin" "$APP_USER"
  fi

  # 755 on the application directory: nginx reads the built bundle from inside
  # it as its own user.
  install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
  install -d -o "$APP_USER" -g "$APP_USER" -m 750 \
    "$DATA_DIR" "$DATA_DIR/uploads" "$DATA_DIR/tesseract" "$DATA_DIR/cache" "$DATA_DIR/npm"
  install -d -m 700 "$CONF_DIR"
}

step_source() {
  ui_run 'Fetching the application source' fetch_source
}

fetch_source() {
  if [[ -n $LOCAL_SOURCE && $LOCAL_SOURCE == "$APP_DIR" ]]; then
    : # Already installed in place; nothing to copy.
  elif [[ -n $LOCAL_SOURCE ]]; then
    # Installing from a checkout: copy the working tree, minus everything that
    # is rebuilt or refetched on this machine anyway.
    tar -C "$LOCAL_SOURCE" \
      --exclude=./node_modules --exclude='./*/node_modules' \
      --exclude=./client/dist --exclude=./server/dist \
      --exclude=./server/uploads --exclude=./server/.tesseract-cache \
      -cf - . | tar -C "$APP_DIR" -xf -
  elif [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$APP_DIR" checkout -B "$REPO_BRANCH" "origin/${REPO_BRANCH}"
    git -C "$APP_DIR" reset --hard "origin/${REPO_BRANCH}"
  else
    # git clone insists on an empty target and $APP_DIR is the service
    # account's home, so clone beside it and move the contents in.
    local staging="${WORK_DIR}/src"
    rm -rf "$staging"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$staging"
    tar -C "$staging" -cf - . | tar -C "$APP_DIR" -xf -
    rm -rf "$staging"
  fi

  # root runs git here but the tree belongs to the service account, which git
  # refuses to touch without this.
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
}

step_dependencies() {
  ui_run 'Installing npm dependencies (the slow one)' install_dependencies
}

step_configure() {
  ui_run 'Writing configuration' write_config
}

write_config() {
  local origins
  if [[ -n $DOMAIN ]]; then
    origins="http://${DOMAIN},https://${DOMAIN}"
    [[ -n $PUBLIC_IP ]] && origins="${origins},http://${PUBLIC_IP}"
  else
    origins="http://${SERVE_HOST}"
  fi

  # The subshell keeps the tighter umask from leaking into later steps, where
  # the built bundle has to stay readable by nginx.
  (
    umask 077

    cat >"$APP_DIR/server/.env" <<EOF
# Written by the ClurkPdf installer on $(date -u '+%Y-%m-%d %H:%M:%SZ').
# Edit, then run: sudo systemctl restart ${SERVICE_NAME}

DATABASE_URL="${DATABASE_URL}"
PORT=${API_PORT}
NODE_ENV=production

# Absolute, so uploads outlive a reinstall of the application directory.
UPLOADS_DIR=${DATA_DIR}/uploads
MAX_FILE_SIZE=$((MAX_UPLOAD_MB * 1024 * 1024))

# nginx terminates the browser connection, so these matter only for a client
# served from somewhere other than this server.
CLIENT_ORIGIN=${origins}

PAGE_DPI=${PAGE_DPI}
THUMBNAIL_WIDTH=150
IMAGE_CACHE_SECONDS=86400

OCR_LANGUAGE=${OCR_LANGUAGE}
OCR_CACHE_DIR=${DATA_DIR}/tesseract
OCR_CONCURRENCY=${OCR_CONCURRENCY}
OCR_TIMEOUT_MS=30000
OCR_MIN_CROP_WIDTH=1000
EOF

    # An empty VITE_SERVER_ORIGIN makes every request relative, so the bundle
    # works whether the browser arrived by domain or by IP, over http or https.
    # VITE_PAGE_DPI has to agree with the server's PAGE_DPI, or 100% zoom shows
    # the page at the wrong size.
    cat >"$APP_DIR/client/.env.production" <<EOF
# Written by the ClurkPdf installer. Same-origin: nginx serves the bundle and
# proxies /api and /uploads to the API on port ${API_PORT}.
VITE_SERVER_ORIGIN=
VITE_PAGE_DPI=${PAGE_DPI}
EOF

    # A record of the install for update.sh, uninstall.sh and the clurkpdf
    # command. Root-only: it names the database.
    cat >"$CONF_DIR/install.conf" <<EOF
# ${APP_TITLE} install record — written $(date -u '+%Y-%m-%d %H:%M:%SZ')
INSTALLER_VERSION='${INSTALLER_VERSION}'
APP_DIR='${APP_DIR}'
DATA_DIR='${DATA_DIR}'
APP_USER='${APP_USER}'
SERVICE_NAME='${SERVICE_NAME}'
API_PORT='${API_PORT}'
DOMAIN='${DOMAIN}'
SERVE_HOST='${SERVE_HOST}'
REPO_URL='${REPO_URL}'
REPO_BRANCH='${REPO_BRANCH}'
DB_LOCAL='${DB_LOCAL}'
DB_NAME='${DB_NAME}'
DB_USER='${DB_USER}'
PKG='${PKG}'
EOF
  )

  chown "$APP_USER:$APP_USER" "$APP_DIR/server/.env" "$APP_DIR/client/.env.production"
  chmod 640 "$APP_DIR/server/.env" "$APP_DIR/client/.env.production"
  chmod 600 "$CONF_DIR/install.conf"
}

step_build() {
  ui_run 'Building the API' app_npm run build:server
  ui_run 'Building the browser bundle' app_npm run build:client
  ui_run 'Verifying the built bundle' verify_bundle
}

step_migrate() {
  ui_run 'Applying database migrations' app_npm run db:deploy
}

step_service() {
  ui_run 'Installing the systemd service' write_service
}

write_service() {
  local after='network-online.target'
  [[ $DB_LOCAL == 1 ]] && after='network-online.target postgresql.service'

  # ProtectHome hides /home entirely, which would break a deployment that was
  # deliberately put there.
  local protect_home='true'
  case "${APP_DIR}:${DATA_DIR}" in
    /home/*|*:/home/*) protect_home='false' ;;
  esac

  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=${APP_TITLE} — ${APP_SUBTITLE}
Documentation=${REPO_URL%.git}
After=${after}
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/server
Environment=NODE_ENV=production
Environment=XDG_CACHE_HOME=${DATA_DIR}/cache
ExecStart=${NODE_BIN:-/usr/bin/node} dist/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
# index.ts closes the server, the OCR workers and the database pool on SIGTERM
# and gives up after ten seconds. Allow a little more than that.
TimeoutStopSec=20
SyslogIdentifier=${SERVICE_NAME}

# The application reads its code from ${APP_DIR} and writes only to ${DATA_DIR}.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=${protect_home}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
}

step_nginx() {
  [[ $DO_NGINX == 1 ]] || return 0
  ui_run 'Configuring the nginx reverse proxy' configure_nginx
}

configure_nginx() {
  pkg_present nginx || pkg_install nginx

  local site_path server_name
  server_name=${DOMAIN:-_}

  # Debian keeps sites in sites-available with a symlink into sites-enabled;
  # RHEL loads conf.d directly. Both are included from nginx.conf's http block.
  if [[ -d /etc/nginx/sites-available ]]; then
    site_path="/etc/nginx/sites-available/${APP_NAME}"
    rm -f /etc/nginx/sites-enabled/default
    ln -sfn "$site_path" "/etc/nginx/sites-enabled/${APP_NAME}"
  else
    site_path="/etc/nginx/conf.d/${APP_NAME}.conf"
    # RHEL's stock nginx.conf claims default_server on port 80, which would
    # both collide with ours and keep the welcome page in front of the app.
    if grep -qs 'default_server' /etc/nginx/nginx.conf; then
      cp -n /etc/nginx/nginx.conf /etc/nginx/nginx.conf.clurkpdf.bak
      sed -i -E 's/(listen[[:space:]]+(\[::\]:)?80)[[:space:]]+default_server/\1/' /etc/nginx/nginx.conf
    fi
  fi

  # Certbot edits this file in place. Keep a copy of whatever was there, so a
  # re-run that overwrites a certbot-managed config can still be recovered.
  if [[ -f $site_path ]]; then
    cp -f "$site_path" "${site_path}.bak.$(date -u '+%Y%m%d%H%M%S')"
  fi

  cat >"$site_path" <<'NGINX'
# ClurkPdf — written by the installer. Certbot adds the TLS server block below.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name __SERVER_NAME__;

    # The compiled React bundle. Everything else is proxied to the API.
    root __ROOT__;
    index index.html;

    client_max_body_size __MAXBODY__M;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # A single-page app: an unknown path is a route, not a missing file.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite fingerprints these filenames, so they can be cached indefinitely.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # A page of regions takes a while to recognise, and the browser client
        # waits three minutes for /ocr. nginx must not give up first.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # Rendered page images. Proxied rather than served straight from disk on
    # purpose: the API refuses everything in the uploads tree except page
    # renders and thumbnails, and serving the directory would hand out the
    # original PDFs alongside them.
    location /uploads/ {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

  sed -i \
    -e "s|__SERVER_NAME__|${server_name}|g" \
    -e "s|__ROOT__|${APP_DIR}/client/dist|g" \
    -e "s|__PORT__|${API_PORT}|g" \
    -e "s|__MAXBODY__|$((MAX_UPLOAD_MB + 2))|g" \
    "$site_path"

  nginx -t
  systemctl enable nginx
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
}

step_tls() {
  [[ $DO_TLS == 1 ]] || return 0
  # A failed certificate must not abort an otherwise working install: the app
  # still serves over http, and certbot can be re-run at any time.
  if ui_run "Requesting a certificate for ${DOMAIN}" request_certificate; then
    return 0
  fi
  TLS_FAILED=1
  return 0
}

request_certificate() {
  case $PKG in
    apt) pkg_install certbot python3-certbot-nginx ;;
    dnf)
      pkg_present epel-release || "$DNF" -y install epel-release || true
      pkg_install certbot python3-certbot-nginx
      ;;
  esac

  # --reinstall matters on a re-run: with a valid certificate already on disk
  # certbot would otherwise take no action, leaving the freshly written nginx
  # config without its TLS block.
  certbot --nginx \
    -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --email "$TLS_EMAIL" \
    --redirect \
    --reinstall \
    --no-eff-email
}

step_firewall() {
  [[ $DO_FIREWALL == 1 ]] || return 0
  ui_run 'Configuring the firewall' configure_firewall
}

configure_firewall() {
  if have ufw; then
    # SSH first, and unconditionally. Enabling ufw without it locks the
    # operator out of the machine they are installing on.
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
    ufw status verbose
  elif have firewall-cmd; then
    systemctl enable --now firewalld
    firewall-cmd --permanent --add-service=ssh
    firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --add-service=https
    firewall-cmd --reload
  else
    echo 'Neither ufw nor firewalld is installed; leaving the firewall alone.' >&2
  fi
  return 0
}

step_start() {
  ui_run "Starting ${SERVICE_NAME}" systemctl restart "$SERVICE_NAME"
  ui_run 'Waiting for the API to answer' wait_for_health 30
}

step_cli() {
  ui_run 'Installing the clurkpdf command' install_cli
}

install_cli() {
  if [[ -f "$APP_DIR/deploy/clurkpdf" ]]; then
    chmod 0755 "$APP_DIR/deploy/clurkpdf" "$APP_DIR/deploy/update.sh" \
      "$APP_DIR/deploy/uninstall.sh" "$APP_DIR/deploy/install.sh" 2>/dev/null || true
    ln -sfn "$APP_DIR/deploy/clurkpdf" /usr/local/bin/clurkpdf
  fi
  return 0
}

# --------------------------------------------------------------------------
# Finish
# --------------------------------------------------------------------------

farewell() {
  local scheme='http'
  [[ $DO_TLS == 1 && $TLS_FAILED == 0 ]] && scheme='https'

  ui_blank
  ui_box "$C_OK" "${APP_TITLE} is running" \
    "$(printf '%-16s %s%s%s' 'Open' "$C_BOLD" "${scheme}://${SERVE_HOST}/" "$C_RESET")" \
    '' \
    "$(printf '%-16s %s' 'Manage'      'clurkpdf status | logs | restart | update')" \
    "$(printf '%-16s %s' 'Service'     "systemctl status ${SERVICE_NAME}")" \
    "$(printf '%-16s %s' 'Journal'     "journalctl -u ${SERVICE_NAME} -f")" \
    '' \
    "$(printf '%-16s %s' 'Application' "$APP_DIR")" \
    "$(printf '%-16s %s' 'Settings'    "${APP_DIR}/server/.env")" \
    "$(printf '%-16s %s' 'Uploads'     "${DATA_DIR}/uploads")" \
    "$(printf '%-16s %s' 'Install log' "$UI_LOG")"

  if [[ $TLS_FAILED == 1 ]]; then
    ui_warn "The certificate request failed; ${APP_TITLE} is serving over http."
    ui_dim "    Check that ${DOMAIN} points at ${PUBLIC_IP:-this server}, then run:"
    ui_dim "    sudo certbot --nginx -d ${DOMAIN}"
  fi
  if [[ $DO_NGINX == 0 ]]; then
    ui_warn "No reverse proxy was configured. The API is on port ${API_PORT} without TLS."
  fi
  if [[ -z $DOMAIN ]]; then
    ui_dim '    Point a domain at this server and re-run with --domain to add https.'
  fi
  ui_blank
}

# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

main() {
  ORIGINAL_ARGS="$*"
  parse_args "$@"

  detect_os
  find_local_source
  load_libs

  [[ $WANT_ASCII == 1 ]] && ui_use_ascii
  ui_init
  [[ $WANT_COLOR == 0 ]] && ui_no_color
  ui_open_input
  open_log

  trap on_error ERR
  trap on_interrupt INT TERM
  trap on_exit EXIT

  # A scratch directory for the whole run: downloaded setup scripts and the
  # clone staging area. load_ui may already have made one.
  [[ -n $WORK_DIR ]] || WORK_DIR=$(mktemp -d /tmp/clurkpdf-install.XXXXXX)

  ui_logo
  ui_tagline "${APP_SUBTITLE} · installer ${INSTALLER_VERSION}"

  preflight
  interview
  show_plan
  plan_steps

  ui_section 'Installing'
  step_swap
  step_base_packages
  step_node
  step_postgres
  step_account
  step_source
  step_dependencies
  # step_configure must come before step_build, and not only for tidiness:
  # `npm run build:server` runs `prisma generate`, prisma.config.ts resolves
  # env('DATABASE_URL'), and Prisma 7 fails outright when it is unset. The
  # build also reads client/.env.production. Both files are written here.
  step_configure
  step_build
  step_migrate
  step_service
  step_nginx
  step_tls
  step_firewall
  step_start
  step_cli

  farewell
}

main "$@"
