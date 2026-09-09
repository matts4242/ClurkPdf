#!/usr/bin/env bash
# Terminal UI for the ClurkPdf deployment scripts.
#
# Sourced by install.sh, update.sh, uninstall.sh and the `clurkpdf` command, so
# every script speaks with the same voice: one logo, one progress bar, one way
# of asking a question.
#
# Three rules shape everything below.
#
#   1. Never assume a terminal. The installer is meant to be run as
#      `curl ... | sudo bash`, which leaves stdout on the terminal but stdin on
#      a pipe. Animation is therefore keyed off stdout, and every prompt reads
#      from /dev/tty rather than stdin.
#   2. Never assume UTF-8 or colour. A minimal VPS image often boots with
#      LANG=C and a dumb terminal. Both degrade to ASCII rather than printing
#      mojibake.
#   3. Command output belongs in the log, not on screen. The spinner shows
#      liveness; the log file holds the detail, and only a failure spills it.

if [[ -n ${CLURK_UI_SOURCED:-} ]]; then
  return 0
fi
CLURK_UI_SOURCED=1

# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

UI_LOG=${UI_LOG:-/dev/null}       # Where command output is appended.
UI_TTY=0                          # 1 when stdout can be animated.
UI_INTERACTIVE=0                  # 1 when a human can answer a prompt.
UI_INPUT_FD=0                     # File descriptor prompts read from.
UI_COLS=80
UI_BAR_W=24
UI_STEP=0                         # Steps completed so far.
UI_STEPS=1                        # Total steps, for the progress bar.
UI_CURRENT_STEP=''                # Label of the running step, named by the
                                  # failure box when something goes wrong.
UI_ASCII=0                        # 1 when the terminal cannot draw box glyphs.
UI_NO_COLOR=${NO_COLOR:+1}

# Glyphs. Reassigned by ui_init when the terminal cannot render Unicode.
UI_TICK='✔'
UI_CROSS='✖'
UI_DOT='◦'
UI_ARROW='›'
UI_BAR_FULL='█'
UI_BAR_EMPTY='░'
UI_BAR_LEFT='▕'
UI_BAR_RIGHT='▏'
UI_BOX_TL='╭'; UI_BOX_TR='╮'; UI_BOX_BL='╰'; UI_BOX_BR='╯'
UI_BOX_H='─'; UI_BOX_V='│'
UI_SPIN_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

# Colours, filled in by ui_init.
C_RESET=''; C_BOLD=''; C_DIM=''
C_BRAND=''; C_ACCENT=''; C_OK=''; C_WARN=''; C_ERR=''; C_MUTED=''

# --------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------

# Decide what this terminal can do. Call once, before anything is printed.
ui_init() {
  if [[ -t 1 ]]; then
    UI_TTY=1
    UI_COLS=$(tput cols 2>/dev/null || echo 80)
  fi
  [[ ${UI_COLS:-0} -ge 60 ]] || UI_COLS=80
  [[ $UI_COLS -le 110 ]] || UI_COLS=110
  [[ $UI_COLS -ge 76 ]] || UI_BAR_W=14

  # A UTF-8 locale is the only reliable signal that block glyphs will render.
  local charmap
  charmap=$(locale charmap 2>/dev/null || true)
  if [[ ${UI_ASCII} != 1 && ! ${charmap} =~ (UTF-8|utf8) && ! ${LANG:-}${LC_ALL:-} =~ (UTF-8|utf8) ]]; then
    UI_ASCII=1
  fi
  if [[ $UI_ASCII == 1 ]]; then
    ui_use_ascii
  fi

  local depth=0
  [[ $UI_TTY == 1 ]] && depth=$(tput colors 2>/dev/null || echo 0)
  if [[ -z ${UI_NO_COLOR} && ${depth:-0} -ge 256 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_BRAND=$'\033[38;5;45m'; C_ACCENT=$'\033[38;5;213m'
    C_OK=$'\033[38;5;42m'; C_WARN=$'\033[38;5;214m'
    C_ERR=$'\033[38;5;203m'; C_MUTED=$'\033[38;5;245m'
  elif [[ -z ${UI_NO_COLOR} && ${depth:-0} -ge 8 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_BRAND=$'\033[36m'; C_ACCENT=$'\033[35m'
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'
    C_ERR=$'\033[31m'; C_MUTED=$'\033[37m'
  fi
}

# Swap every drawing glyph for its ASCII equivalent.
ui_use_ascii() {
  UI_ASCII=1
  UI_TICK='+'; UI_CROSS='x'; UI_DOT='-'; UI_ARROW='>'
  UI_BAR_FULL='#'; UI_BAR_EMPTY='.'; UI_BAR_LEFT='['; UI_BAR_RIGHT=']'
  UI_BOX_TL='+'; UI_BOX_TR='+'; UI_BOX_BL='+'; UI_BOX_BR='+'
  UI_BOX_H='-'; UI_BOX_V='|'
  UI_SPIN_FRAMES=('|' '/' '-' '\')
}

ui_no_color() {
  UI_NO_COLOR=1
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_BRAND=''; C_ACCENT=''; C_OK=''; C_WARN=''; C_ERR=''; C_MUTED=''
}

# Bind prompts to the controlling terminal. `curl | bash` leaves stdin on the
# pipe, so reading from fd 0 would consume the script itself.
ui_open_input() {
  # The device node exists even where there is no controlling terminal to open,
  # so the open has to be attempted. The brace group carries the redirection:
  # on `exec 3</dev/tty 2>/dev/null` bash opens fd 3 — and reports the failure —
  # before it ever gets to the 2>.
  if [[ -e /dev/tty ]] && { exec 3</dev/tty; } 2>/dev/null; then
    UI_INPUT_FD=3
    UI_INTERACTIVE=1
  elif [[ -t 0 ]]; then
    UI_INPUT_FD=0
    UI_INTERACTIVE=1
  else
    UI_INTERACTIVE=0
  fi
}

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------

ui_log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$UI_LOG" 2>/dev/null || true
}

# --------------------------------------------------------------------------
# Logo
# --------------------------------------------------------------------------

# The wordmark, six rows of block letters split into CLURK and PDF so the two
# halves can carry different colours. Falls back to a compact form when the
# terminal is too narrow or cannot draw the glyphs.
ui_logo() {
  local -a left right
  left=(
' ██████╗██╗     ██╗   ██╗██████╗ ██╗  ██╗'
'██╔════╝██║     ██║   ██║██╔══██╗██║ ██╔╝'
'██║     ██║     ██║   ██║██████╔╝█████╔╝ '
'██║     ██║     ██║   ██║██╔══██╗██╔═██╗ '
'╚██████╗███████╗╚██████╔╝██║  ██║██║  ██╗'
' ╚═════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝'
  )
  right=(
'██████╗ ██████╗ ███████╗'
'██╔══██╗██╔══██╗██╔════╝'
'██████╔╝██║  ██║█████╗  '
'██╔═══╝ ██║  ██║██╔══╝  '
'██║     ██████╔╝██║     '
'╚═╝     ╚═════╝ ╚═╝     '
  )
  # Row-by-row gradients: cyan into blue, pink into violet.
  local -a lc=(51 45 39 33 27 26)
  local -a rc=(219 213 207 201 165 129)

  printf '\n'
  if [[ $UI_ASCII == 1 || $UI_COLS -lt 70 ]]; then
    ui_logo_compact
    return
  fi

  local i
  for i in "${!left[@]}"; do
    if [[ -n $C_BRAND && -z ${UI_NO_COLOR} ]]; then
      printf '  \033[38;5;%sm%s\033[38;5;%sm%s%s\n' \
        "${lc[i]}" "${left[i]}" "${rc[i]}" "${right[i]}" "$C_RESET"
    else
      printf '  %s%s\n' "${left[i]}" "${right[i]}"
    fi
  done
}

ui_logo_compact() {
  if [[ $UI_ASCII == 1 ]]; then
    printf '  %s%s== CLURK PDF ==%s\n' "$C_BOLD" "$C_BRAND" "$C_RESET"
    return
  fi
  printf '  %s%s┌─┐┬  ┬ ┬┬─┐┬┌─%s  %s┌─┐┌┬┐┌─┐%s\n' "$C_BOLD" "$C_BRAND" "$C_RESET" "$C_ACCENT" "$C_RESET"
  printf '  %s%s│  │  │ │├┬┘├┴┐%s  %s├─┘ ││├┤ %s\n' "$C_BOLD" "$C_BRAND" "$C_RESET" "$C_ACCENT" "$C_RESET"
  printf '  %s%s└─┘┴─┘└─┘┴└─┴ ┴%s  %s┴  ─┴┘└  %s\n' "$C_BOLD" "$C_BRAND" "$C_RESET" "$C_ACCENT" "$C_RESET"
}

ui_tagline() {
  printf '  %s%s%s\n' "$C_MUTED" "$1" "$C_RESET"
  printf '\n'
}

# --------------------------------------------------------------------------
# Plain output
# --------------------------------------------------------------------------

ui_blank()   { printf '\n'; }
ui_say()     { printf '  %s\n' "$*"; }
ui_dim()     { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ui_info()    { printf '  %s%s%s %s\n' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$*"; }
ui_ok()      { printf '  %s%s%s %s\n' "$C_OK" "$UI_TICK" "$C_RESET" "$*"; ui_log "OK: $*"; }
ui_warn()    { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; ui_log "WARN: $*"; }
ui_err()     { printf '  %s%s%s %s\n' "$C_ERR" "$UI_CROSS" "$C_RESET" "$*" >&2; ui_log "ERROR: $*"; }

ui_section() {
  printf '\n  %s%s%s %s%s\n' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$C_BOLD" "$1"
  printf '  %s%s%s\n' "$C_DIM" "$(ui_repeat "$UI_BOX_H" $((UI_COLS - 4)))" "$C_RESET"
}

ui_kv() {
  printf '    %s%-22s%s %s\n' "$C_MUTED" "$1" "$C_RESET" "$2"
}

ui_repeat() {
  local char=$1 count=$2 out=''
  local i
  for ((i = 0; i < count; i++)); do out+=$char; done
  printf '%s' "$out"
}

# Visible length of a string, ignoring the ANSI escapes inside it.
ui_width() {
  local stripped
  stripped=$(printf '%s' "$1" | sed -e "s/$(printf '\033')\[[0-9;]*m//g")
  printf '%s' "${#stripped}"
}

# Cut a string to at most <width> characters, so a long label cannot wrap the
# spinner line and leave half of it on screen.
ui_clamp() {
  local text=$1 width=$2
  if [[ ${#text} -le $width ]]; then
    printf '%s' "$text"
  else
    printf '%s...' "${text:0:$((width - 3))}"
  fi
}

# --------------------------------------------------------------------------
# Boxes
# --------------------------------------------------------------------------

# ui_box <colour> <title> <line>...
ui_box() {
  local color=$1 title=$2; shift 2
  local width=$((UI_COLS - 4))
  local inner=$((width - 2))

  printf '\n  %s%s%s' "$color" "$UI_BOX_TL" "$C_RESET"
  if [[ -n $title ]]; then
    local head=" $title "
    printf '%s%s%s%s%s%s%s' \
      "$color" "$UI_BOX_H" "$C_RESET" "$C_BOLD$head$C_RESET" \
      "$color" "$(ui_repeat "$UI_BOX_H" $((inner - ${#head} - 1)))" "$C_RESET"
  else
    printf '%s%s%s' "$color" "$(ui_repeat "$UI_BOX_H" "$inner")" "$C_RESET"
  fi
  printf '%s%s%s\n' "$color" "$UI_BOX_TR" "$C_RESET"

  local line visible pad over
  for line in "$@"; do
    visible=$(ui_width "$line")
    # Too long for the box: cut the tail and close any colour that was open,
    # rather than pushing the right border off the edge of the terminal.
    over=$((visible - inner + 1))
    if ((over > 0)); then
      line="${line:0:$((${#line} - over - 3))}...${C_RESET}"
      visible=$((inner - 1))
    fi
    pad=$((inner - visible - 1))
    ((pad < 0)) && pad=0
    printf '  %s%s%s %s%s%s%s\n' \
      "$color" "$UI_BOX_V" "$C_RESET" "$line" "$(ui_repeat ' ' "$pad")" \
      "$color$UI_BOX_V" "$C_RESET"
  done

  printf '  %s%s%s%s%s\n\n' \
    "$color" "$UI_BOX_BL" "$(ui_repeat "$UI_BOX_H" "$inner")" "$UI_BOX_BR" "$C_RESET"
}

# --------------------------------------------------------------------------
# Progress
# --------------------------------------------------------------------------

# Render a determinate bar as a string: ▕████████░░░░░░░░▏
ui_bar() {
  local percent=$1 width=${2:-$UI_BAR_W}
  ((percent < 0)) && percent=0
  ((percent > 100)) && percent=100
  local filled=$((percent * width / 100))
  printf '%s%s%s%s%s%s%s%s%s' \
    "$C_DIM" "$UI_BAR_LEFT" "$C_RESET" \
    "$C_BRAND" "$(ui_repeat "$UI_BAR_FULL" "$filled")" \
    "$C_DIM" "$(ui_repeat "$UI_BAR_EMPTY" $((width - filled)))" \
    "$UI_BAR_RIGHT" "$C_RESET"
}

# Declare how many ui_run steps the script will take, so the bar is truthful.
ui_steps_total() {
  UI_STEPS=$1
  UI_STEP=0
}

_UI_SPIN_PID=''

# Animate one step until _ui_spin_stop is called. The bar shows overall
# progress through the install; the spinner and the clock show that the current
# command is still alive.
_ui_spin_start() {
  local label=$1 percent=$2
  # Without a terminal there is nothing to animate: the finished line printed
  # by _ui_spin_stop is the whole record of the step.
  [[ $UI_TTY == 1 ]] || return 0

  local field=$((UI_COLS - UI_BAR_W - 20))
  label=$(ui_clamp "$label" "$field")
  printf '\033[?25l'    # hide the cursor
  (
    local i=0 start elapsed frame
    start=$SECONDS
    while :; do
      frame=${UI_SPIN_FRAMES[i % ${#UI_SPIN_FRAMES[@]}]}
      elapsed=$((SECONDS - start))
      printf '\r  %s%s%s %s %3s%%  %-*s %s%3ss%s' \
        "$C_BRAND" "$frame" "$C_RESET" \
        "$(ui_bar "$percent")" "$percent" \
        "$field" "$label" \
        "$C_DIM" "$elapsed" "$C_RESET"
      i=$((i + 1))
      sleep 0.1
    done
  ) &
  _UI_SPIN_PID=$!
}

# _ui_spin_stop <exit-code> <label> <seconds> [<percent>]
_ui_spin_stop() {
  local rc=$1 label=$2 secs=$3 percent=${4:-100}
  if [[ -n $_UI_SPIN_PID ]]; then
    kill "$_UI_SPIN_PID" 2>/dev/null || true
    wait "$_UI_SPIN_PID" 2>/dev/null || true
    _UI_SPIN_PID=''
  fi

  local mark color
  case $rc in
    0)  mark=$UI_TICK;  color=$C_OK ;;
    99) mark=$UI_DOT;   color=$C_MUTED ;;   # skipped, or a dry run
    *)  mark=$UI_CROSS; color=$C_ERR ;;
  esac

  local field=$((UI_COLS - UI_BAR_W - 20))
  if [[ $UI_TTY == 1 ]]; then
    printf '\r\033[2K'   # erase the spinner line before replacing it
  fi
  printf '  %s%s%s %s %3s%%  %-*s %s%3ss%s\n' \
    "$color" "$mark" "$C_RESET" \
    "$(ui_bar "$percent")" "$percent" \
    "$field" "$(ui_clamp "$label" "$field")" \
    "$C_DIM" "$secs" "$C_RESET"
  if [[ $UI_TTY == 1 ]]; then
    printf '\033[?25h'   # show the cursor
  fi
}

# Leaving the cursor hidden after an interrupted install would follow the user
# into their next command, so every exit path calls this.
ui_cursor_show() {
  if [[ $UI_TTY == 1 ]]; then
    printf '\033[?25h'
  fi
  return 0
}

# Stop any spinner still running, without printing a result line. Used by the
# interrupt handler, which prints its own.
ui_spin_abort() {
  if [[ -n $_UI_SPIN_PID ]]; then
    kill "$_UI_SPIN_PID" 2>/dev/null || true
    wait "$_UI_SPIN_PID" 2>/dev/null || true
    _UI_SPIN_PID=''
    [[ $UI_TTY == 1 ]] && printf '\r\033[2K'
  fi
  ui_cursor_show
}

# ui_run <label> <command> [args...]
#
# Runs one installation step with the spinner in front and the command's own
# output in the log. Returns the command's exit status, so a caller running
# under `set -e` stops at the first real failure.
ui_run() {
  local label=$1; shift
  UI_STEP=$((UI_STEP + 1))
  UI_CURRENT_STEP=$label
  local percent=$((UI_STEP * 100 / UI_STEPS))
  ui_log "--- step ${UI_STEP}/${UI_STEPS}: ${label}"
  ui_log "\$ $*"

  if [[ ${DRY_RUN:-0} == 1 ]]; then
    _ui_spin_start "$label" "$percent"
    sleep 0.35
    _ui_spin_stop 99 "$label" 0 "$percent"
    ui_dim "     would run: $*"
    return 0
  fi

  local start=$SECONDS rc=0
  _ui_spin_start "$label" "$percent"
  if ! "$@" >>"$UI_LOG" 2>&1; then
    rc=$?
  fi
  _ui_spin_stop "$rc" "$label" $((SECONDS - start)) "$percent"
  return "$rc"
}

# Same as ui_run, but the step is recorded as deliberately skipped.
ui_skip() {
  local label=$1 reason=${2:-}
  UI_STEP=$((UI_STEP + 1))
  local percent=$((UI_STEP * 100 / UI_STEPS))
  ui_log "--- step ${UI_STEP}/${UI_STEPS}: ${label} (skipped: ${reason})"
  _ui_spin_stop 99 "$label" 0 "$percent"
  [[ -n $reason ]] && ui_dim "     $reason"
  return 0
}

# The last lines of the log, for when a step fails.
ui_log_tail() {
  local lines=${1:-25}
  [[ -r $UI_LOG ]] || return 0
  printf '\n  %slast %s lines of %s%s\n' "$C_DIM" "$lines" "$UI_LOG" "$C_RESET"
  printf '  %s%s%s\n' "$C_DIM" "$(ui_repeat "$UI_BOX_H" $((UI_COLS - 4)))" "$C_RESET"
  local line
  while IFS= read -r line; do
    printf '  %s%s%s\n' "$C_DIM" "${line:0:$((UI_COLS - 6))}" "$C_RESET"
  done < <(tail -n "$lines" "$UI_LOG")
  printf '  %s%s%s\n\n' "$C_DIM" "$(ui_repeat "$UI_BOX_H" $((UI_COLS - 4)))" "$C_RESET"
}

# --------------------------------------------------------------------------
# Prompts
# --------------------------------------------------------------------------
#
# Every prompt honours ASSUME_YES, so the same script drives both an
# interactive install and an unattended one.

# ui_ask <varname> <question> <default>
ui_ask() {
  local __var=$1 question=$2 default=${3:-} answer=''
  if [[ ${ASSUME_YES:-0} == 1 || $UI_INTERACTIVE != 1 ]]; then
    printf -v "$__var" '%s' "$default"
    printf '  %s%s%s %s %s%s%s\n' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question" "$C_DIM" "${default:-(empty)}" "$C_RESET"
    return 0
  fi
  if [[ -n $default ]]; then
    printf '  %s%s%s %s %s[%s]%s ' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question" "$C_DIM" "$default" "$C_RESET"
  else
    printf '  %s%s%s %s ' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question"
  fi
  IFS= read -r answer <&"$UI_INPUT_FD" || answer=''
  printf -v "$__var" '%s' "${answer:-$default}"
}

# ui_ask_secret <varname> <question>
ui_ask_secret() {
  local __var=$1 question=$2 answer=''
  if [[ ${ASSUME_YES:-0} == 1 || $UI_INTERACTIVE != 1 ]]; then
    printf -v "$__var" '%s' ''
    return 0
  fi
  printf '  %s%s%s %s ' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question"
  IFS= read -rs answer <&"$UI_INPUT_FD" || answer=''
  printf '\n'
  printf -v "$__var" '%s' "$answer"
}

# ui_confirm <question> [yes|no]
ui_confirm() {
  local question=$1 default=${2:-yes} answer='' hint
  [[ $default == yes ]] && hint='Y/n' || hint='y/N'

  if [[ ${ASSUME_YES:-0} == 1 || $UI_INTERACTIVE != 1 ]]; then
    printf '  %s%s%s %s %s%s%s\n' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question" "$C_DIM" "$default" "$C_RESET"
    [[ $default == yes ]]
    return
  fi

  while :; do
    printf '  %s%s%s %s %s[%s]%s ' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question" "$C_DIM" "$hint" "$C_RESET"
    IFS= read -r answer <&"$UI_INPUT_FD" || answer=''
    answer=${answer:-$default}
    case ${answer,,} in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
      *)     ui_warn 'Please answer y or n.' ;;
    esac
  done
}

# ui_menu <varname> <question> <value:label>...
#
# Prints a numbered list and returns the chosen value. The first option is the
# default, which is also what an unattended run picks.
ui_menu() {
  local __var=$1 question=$2; shift 2
  local -a values=() labels=()
  local option
  for option in "$@"; do
    values+=("${option%%:*}")
    labels+=("${option#*:}")
  done

  if [[ ${ASSUME_YES:-0} == 1 || $UI_INTERACTIVE != 1 ]]; then
    printf -v "$__var" '%s' "${values[0]}"
    printf '  %s%s%s %s %s%s%s\n' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question" "$C_DIM" "${labels[0]}" "$C_RESET"
    return 0
  fi

  printf '  %s%s%s %s\n' "$C_BRAND" "$UI_ARROW" "$C_RESET" "$question"
  local i
  for i in "${!labels[@]}"; do
    printf '      %s%s)%s %s%s\n' "$C_BOLD" "$((i + 1))" "$C_RESET" "${labels[i]}" \
      "$([[ $i == 0 ]] && printf '%s (default)%s' "$C_DIM" "$C_RESET")"
  done

  local answer
  while :; do
    printf '    %sselect 1-%s%s [1] ' "$C_DIM" "${#labels[@]}" "$C_RESET"
    IFS= read -r answer <&"$UI_INPUT_FD" || answer=''
    answer=${answer:-1}
    if [[ $answer =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= ${#labels[@]})); then
      printf -v "$__var" '%s' "${values[answer - 1]}"
      return 0
    fi
    ui_warn "Enter a number between 1 and ${#labels[@]}."
  done
}

ui_die() {
  ui_cursor_show
  ui_blank
  ui_box "$C_ERR" 'Install failed' "$C_ERR$UI_CROSS$C_RESET $1" '' "Log: $UI_LOG"
  exit "${2:-1}"
}
