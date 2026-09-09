#!/usr/bin/env bash
#
#   ClurkPdf — update an existing deployment
#
#   sudo clurkpdf update              (or: sudo /opt/clurkpdf/deploy/update.sh)
#
# Pulls the latest source, reinstalls dependencies, rebuilds both packages,
# applies any new migrations and restarts the service. The database is dumped
# first, because a migration is the one step here that cannot simply be redone.
#
# Everything it needs to know comes from /etc/clurkpdf/install.conf, which the
# installer wrote.

set -Eeuo pipefail

UPDATE_VERSION='1.0.0'

ASSUME_YES=0
DRY_RUN=0
FORCE=0
DO_BACKUP=1
WANT_COLOR=1
WANT_ASCII=0
TARGET_BRANCH=''
OLD_COMMIT=''
NEW_COMMIT=''

UI_LOG=${CLURK_LOG:-/var/log/clurkpdf-update.log}

usage() {
  cat <<'EOF'
ClurkPdf update — pull, rebuild, migrate, restart

USAGE
  sudo clurkpdf update [options]
  sudo /opt/clurkpdf/deploy/update.sh [options]

OPTIONS
  -y, --yes           Do not prompt.
      --branch <name> Update to this branch instead of the installed one.
      --force         Rebuild even when the branch has not moved.
      --no-backup     Skip the database dump taken before migrating.
      --no-color      Disable colour.
      --ascii         Force ASCII drawing characters.
      --dry-run       Show every step without changing anything.
  -h, --help          This text.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      -y|--yes)     ASSUME_YES=1 ;;
      --branch)     TARGET_BRANCH=${2:-}; shift ;;
      --force)      FORCE=1 ;;
      --no-backup)  DO_BACKUP=0 ;;
      --no-color)   WANT_COLOR=0 ;;
      --ascii)      WANT_ASCII=1 ;;
      --dry-run)    DRY_RUN=1 ;;
      -h|--help)    usage; exit 0 ;;
      *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 1 ;;
    esac
    shift
  done
}

# The libraries sit next to this script. Resolved and exported before the
# re-exec below, because the copy that re-runs lives in /tmp and could not find
# them on its own.
if [[ -z ${CLURK_LIB_DIR:-} ]]; then
  CLURK_LIB_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/lib" && pwd)
  export CLURK_LIB_DIR
fi
# shellcheck source=lib/ui.sh
. "${CLURK_LIB_DIR}/ui.sh"
# shellcheck source=lib/common.sh
. "${CLURK_LIB_DIR}/common.sh"

on_error() {
  local rc=$?
  ui_spin_abort
  ui_box "$C_ERR" 'Update failed' \
    "Step: ${UI_CURRENT_STEP:-startup}" \
    "Exit status ${rc}." \
    '' \
    "The previous revision was ${OLD_COMMIT:-unknown}." \
    "To go back:  sudo -u ${APP_USER:-clurkpdf} git -C ${APP_DIR:-/opt/clurkpdf} reset --hard ${OLD_COMMIT:-HEAD@{1}}" \
    '' \
    "Full output: ${UI_LOG}"
  ui_log_tail 25
  exit "$rc"
}

on_interrupt() {
  ui_spin_abort
  printf '\n'
  ui_warn 'Interrupted.'
  exit 130
}

# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------

step_backup() {
  [[ $DO_BACKUP == 1 ]] || return 0
  ui_run 'Backing up the database' backup_database
}

backup_database() {
  local dir="$DATA_DIR/backups"
  install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$dir"
  local stamp file
  stamp=$(date -u '+%Y%m%d-%H%M%S')
  file="${dir}/${DB_NAME:-clurkpdf}-${stamp}.sql.gz"

  if [[ ${DB_LOCAL:-0} == 1 ]]; then
    runuser -u postgres -- pg_dump --no-owner "${DB_NAME:-clurkpdf}" | gzip -9 >"$file"
  else
    # An external database is reached with the same URL the application uses.
    [[ -n $(app_database_url) ]] || { echo 'No DATABASE_URL found in server/.env' >&2; return 1; }
    pg_dump_app | gzip -9 >"$file"
  fi

  chown "$APP_USER:$APP_USER" "$file"
  chmod 640 "$file"
  echo "Wrote ${file}"

  # Keep the five most recent dumps; older ones are the operator's problem.
  local old
  old=$(ls -1t "${dir}"/*.sql.gz 2>/dev/null | tail -n +6 || true)
  [[ -z $old ]] || printf '%s\n' "$old" | xargs -r rm -f
  return 0
}

step_fetch() {
  ui_run "Fetching ${REPO_BRANCH}" fetch_source
}

fetch_source() {
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$APP_DIR" checkout -B "$REPO_BRANCH" "origin/${REPO_BRANCH}"
  git -C "$APP_DIR" reset --hard "origin/${REPO_BRANCH}"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"

  # Remember a --branch switch, so the next update does not quietly go back to
  # the branch the installer recorded.
  if [[ -n $TARGET_BRANCH ]]; then
    sed -i "s|^REPO_BRANCH=.*|REPO_BRANCH='${REPO_BRANCH}'|" "$CONF_FILE"
  fi
}

step_build() {
  ui_run 'Installing npm dependencies' install_dependencies
  ui_run 'Building the API' app_npm run build:server
  ui_run 'Building the browser bundle' app_npm run build:client
  ui_run 'Verifying the built bundle' verify_bundle
}

step_migrate() {
  ui_run 'Applying database migrations' app_npm run db:deploy
}

step_restart() {
  ui_run "Restarting ${SERVICE_NAME}" systemctl restart "$SERVICE_NAME"
  ui_run 'Waiting for the API to answer' wait_for_health 30
}

# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

main() {
  parse_args "$@"

  [[ $WANT_ASCII == 1 ]] && ui_use_ascii
  ui_init
  [[ $WANT_COLOR == 0 ]] && ui_no_color
  ui_open_input

  require_root 'clurkpdf update'
  load_install_conf
  [[ -z $TARGET_BRANCH ]] || REPO_BRANCH=$TARGET_BRANCH

  # git reset --hard rewrites this script mid-run; carry on from a copy.
  reexec_from_copy "$@"

  mkdir -p "$(dirname -- "$UI_LOG")" 2>/dev/null || UI_LOG=/tmp/clurkpdf-update.log
  touch "$UI_LOG" 2>/dev/null || UI_LOG=/dev/null
  [[ $UI_LOG == /dev/null ]] || chmod 600 "$UI_LOG"

  trap on_error ERR
  trap on_interrupt INT TERM
  trap clean_reexec_copy EXIT

  ui_logo
  ui_tagline "Update · ${UPDATE_VERSION}"

  ui_section 'Current deployment'
  OLD_COMMIT=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')
  ui_kv 'Installed at' "$APP_DIR"
  ui_kv 'Branch' "$REPO_BRANCH"
  ui_kv 'Revision' "$OLD_COMMIT"
  ui_kv 'Service' "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)"

  if [[ $DRY_RUN != 1 ]]; then
    git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
    if git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH" >>"$UI_LOG" 2>&1; then
      NEW_COMMIT=$(git -C "$APP_DIR" rev-parse --short "origin/${REPO_BRANCH}" 2>/dev/null || echo 'unknown')
      ui_kv 'Available' "$NEW_COMMIT"
      if [[ $NEW_COMMIT == "$OLD_COMMIT" && $FORCE != 1 ]]; then
        ui_blank
        ui_ok "Already up to date at ${OLD_COMMIT}. Use --force to rebuild anyway."
        exit 0
      fi
    else
      ui_warn "Could not reach ${REPO_URL}; the update will use whatever is already fetched."
    fi
  fi

  ui_blank
  if [[ $DRY_RUN == 1 ]]; then
    ui_warn 'Dry run: every step below is printed, nothing is executed.'
  else
    ui_warn 'Local modifications inside the application directory will be discarded.'
    if ! ui_confirm "Update ${APP_DIR} to ${NEW_COMMIT:-the latest revision}?" yes; then
      ui_info 'Nothing was changed.'
      exit 0
    fi
  fi

  local total=8
  [[ $DO_BACKUP == 1 ]] && total=$((total + 1))
  ui_steps_total "$total"

  ui_section 'Updating'
  step_backup
  step_fetch
  step_build
  step_migrate
  step_restart

  NEW_COMMIT=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')
  ui_blank
  ui_box "$C_OK" 'Update complete' \
    "$(printf '%-14s %s' 'Was' "$OLD_COMMIT")" \
    "$(printf '%-14s %s' 'Now' "$NEW_COMMIT")" \
    "$(printf '%-14s %s' 'Open' "$(app_url)")" \
    "$(printf '%-14s %s' 'Log' "$UI_LOG")"
  ui_blank
}

main "$@"
