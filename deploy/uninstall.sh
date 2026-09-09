#!/usr/bin/env bash
#
#   ClurkPdf — remove a deployment
#
#   sudo clurkpdf uninstall           (or: sudo /opt/clurkpdf/deploy/uninstall.sh)
#
# Always removes the service, the nginx site and the clurkpdf command. Asks
# separately about each of the three things that cannot be put back: the
# database, the uploaded documents, and the service account.
#
# PostgreSQL, Node.js and nginx are left installed. They are ordinary system
# packages that something else on the machine may be using, so removing them is
# not this script's decision to make.

set -Eeuo pipefail

ASSUME_YES=0
DRY_RUN=0
PURGE=0
KEEP_DATA=0
WANT_COLOR=1
WANT_ASCII=0

DROP_DB=0
REMOVE_DATA=0
REMOVE_USER=0

UI_LOG=${CLURK_LOG:-/var/log/clurkpdf-uninstall.log}

usage() {
  cat <<'EOF'
ClurkPdf uninstall — remove the service, the proxy and (optionally) the data

USAGE
  sudo clurkpdf uninstall [options]
  sudo /opt/clurkpdf/deploy/uninstall.sh [options]

OPTIONS
  -y, --yes         Do not prompt. Without --purge this keeps the database,
                    the uploads and the service account.
      --purge       Also drop the database, delete the uploads and remove the
                    service account. Everything goes.
      --keep-data   Never touch the database or the uploads, even with --purge.
      --no-color    Disable colour.
      --ascii       Force ASCII drawing characters.
      --dry-run     Show every step without changing anything.
  -h, --help        This text.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      -y|--yes)    ASSUME_YES=1 ;;
      --purge)     PURGE=1 ;;
      --keep-data) KEEP_DATA=1 ;;
      --no-color)  WANT_COLOR=0 ;;
      --ascii)     WANT_ASCII=1 ;;
      --dry-run)   DRY_RUN=1 ;;
      -h|--help)   usage; exit 0 ;;
      *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 1 ;;
    esac
    shift
  done
}

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
  ui_box "$C_ERR" 'Uninstall failed' \
    "Step: ${UI_CURRENT_STEP:-startup}" \
    "Exit status ${rc}. The deployment may be half-removed." \
    '' \
    "Full output: ${UI_LOG}"
  ui_log_tail 20
  exit "$rc"
}

# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------

step_stop() {
  ui_run "Stopping ${SERVICE_NAME}" stop_service
}

stop_service() {
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
  return 0
}

step_nginx() {
  ui_run 'Removing the nginx site' remove_nginx_site
}

remove_nginx_site() {
  local changed=0
  if [[ -e /etc/nginx/sites-enabled/clurkpdf || -e /etc/nginx/sites-available/clurkpdf ]]; then
    rm -f /etc/nginx/sites-enabled/clurkpdf /etc/nginx/sites-available/clurkpdf
    changed=1
  fi
  if [[ -e /etc/nginx/conf.d/clurkpdf.conf ]]; then
    rm -f /etc/nginx/conf.d/clurkpdf.conf
    changed=1
  fi
  # The installer removed the distribution's default site to take over port 80.
  # Put it back, so nginx still has something to answer with.
  if [[ -e /etc/nginx/sites-available/default && ! -e /etc/nginx/sites-enabled/default ]]; then
    ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  fi
  if [[ -f /etc/nginx/nginx.conf.clurkpdf.bak ]]; then
    mv -f /etc/nginx/nginx.conf.clurkpdf.bak /etc/nginx/nginx.conf
    changed=1
  fi

  if [[ $changed == 1 ]] && have nginx; then
    nginx -t && { systemctl reload nginx || systemctl restart nginx; }
  fi
  return 0
}

step_database() {
  [[ $DROP_DB == 1 ]] || return 0
  ui_run "Dropping the ${DB_NAME} database" drop_database
}

drop_database() {
  # Sessions still holding the database would make DROP DATABASE fail.
  psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()" >/dev/null || true
  psql_admin "DROP DATABASE IF EXISTS ${DB_NAME}"
  psql_admin "DROP ROLE IF EXISTS ${DB_USER}"
}

step_files() {
  ui_run 'Removing the application directory' remove_app_dir
  [[ $REMOVE_DATA == 1 ]] || return 0
  ui_run 'Removing uploads and cached data' remove_data_dir
}

remove_app_dir() {
  # A deliberately narrow target: never let a mangled config turn this into
  # rm -rf on something important.
  case $APP_DIR in
    /|/usr|/etc|/var|/home|/opt|'') echo "Refusing to remove ${APP_DIR}" >&2; return 1 ;;
  esac
  rm -rf "$APP_DIR"
  rm -f /usr/local/bin/clurkpdf
  return 0
}

remove_data_dir() {
  case $DATA_DIR in
    /|/usr|/etc|/var|/home|/opt|'') echo "Refusing to remove ${DATA_DIR}" >&2; return 1 ;;
  esac
  rm -rf "$DATA_DIR"
  return 0
}

step_account() {
  [[ $REMOVE_USER == 1 ]] || return 0
  ui_run "Removing the ${APP_USER} account" remove_account
}

remove_account() {
  if id -u "$APP_USER" >/dev/null 2>&1; then
    userdel "$APP_USER" 2>/dev/null || true
  fi
  return 0
}

step_conf() {
  ui_run 'Removing the install record' remove_conf
}

remove_conf() {
  rm -f "$CONF_FILE"
  rmdir /etc/clurkpdf 2>/dev/null || true
  return 0
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

  require_root 'clurkpdf uninstall'
  load_install_conf

  # This script deletes the directory it lives in.
  reexec_from_copy "$@"

  mkdir -p "$(dirname -- "$UI_LOG")" 2>/dev/null || UI_LOG=/tmp/clurkpdf-uninstall.log
  touch "$UI_LOG" 2>/dev/null || UI_LOG=/dev/null

  trap on_error ERR
  trap 'ui_spin_abort; exit 130' INT TERM
  trap clean_reexec_copy EXIT

  ui_logo
  ui_tagline 'Uninstall'

  ui_section 'What will be removed'
  ui_kv 'Service' "$SERVICE_NAME"
  ui_kv 'Application' "$APP_DIR"
  ui_kv 'nginx site' 'clurkpdf'
  ui_kv 'Command' '/usr/local/bin/clurkpdf'
  ui_blank
  ui_dim '  PostgreSQL, Node.js and nginx themselves are left installed.'
  ui_dim '  Any Let'"'"'s Encrypt certificate is left in /etc/letsencrypt.'

  if [[ $KEEP_DATA != 1 ]]; then
    ui_section 'What would be lost'
    ui_kv 'Database' "${DB_NAME} on this server"
    ui_kv 'Uploads' "${DATA_DIR}/uploads"
    ui_blank

    if [[ $PURGE == 1 ]]; then
      DROP_DB=${DB_LOCAL:-0}
      REMOVE_DATA=1
      REMOVE_USER=1
    elif [[ $ASSUME_YES != 1 ]]; then
      if [[ ${DB_LOCAL:-0} == 1 ]] && ui_confirm 'Drop the database and its role?' no; then
        DROP_DB=1
      fi
      if ui_confirm "Delete every uploaded document under ${DATA_DIR}?" no; then
        REMOVE_DATA=1
      fi
      if ui_confirm "Remove the ${APP_USER} service account?" no; then
        REMOVE_USER=1
      fi
    fi
  fi

  ui_blank
  if [[ $DRY_RUN == 1 ]]; then
    ui_warn 'Dry run: every step below is printed, nothing is executed.'
  elif [[ $DROP_DB == 1 || $REMOVE_DATA == 1 ]]; then
    # Irreversible. Make the operator type the word rather than press return.
    local answer=''
    if [[ $ASSUME_YES == 1 || $PURGE == 1 ]]; then
      ui_warn 'Removing data without asking, because --purge or --yes was given.'
    else
      ui_warn 'This deletes data that cannot be recovered.'
      ui_ask answer "Type REMOVE to confirm" ''
      if [[ $answer != 'REMOVE' ]]; then
        ui_info 'Nothing was changed.'
        exit 0
      fi
    fi
  elif ! ui_confirm 'Remove the service, the nginx site and the application?' no; then
    ui_info 'Nothing was changed.'
    exit 0
  fi

  # Stop, nginx, application directory, install record — then whatever the
  # answers above added.
  local total=4
  [[ $DROP_DB == 1 ]]     && total=$((total + 1))
  [[ $REMOVE_DATA == 1 ]] && total=$((total + 1))
  [[ $REMOVE_USER == 1 ]] && total=$((total + 1))
  ui_steps_total "$total"

  ui_section 'Removing'
  step_stop
  step_nginx
  step_database
  step_files
  step_account
  step_conf

  ui_blank
  local -a lines=('The service, the nginx site and the application are gone.' '')
  [[ $DROP_DB == 1 ]]     || lines+=("Kept: the ${DB_NAME} database")
  [[ $REMOVE_DATA == 1 ]] || lines+=("Kept: everything under ${DATA_DIR}")
  [[ $REMOVE_USER == 1 ]] || lines+=("Kept: the ${APP_USER} service account")
  [[ ${#lines[@]} -gt 2 ]] || lines=('Everything is gone: service, application, database and uploads.')

  ui_box "$C_OK" 'ClurkPdf removed' "${lines[@]}"
  ui_blank
}

main "$@"
