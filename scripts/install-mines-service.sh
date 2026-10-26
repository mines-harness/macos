#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: install-service.sh --runtime-dir DIR [options]

Install a user systemd service for an extracted mines Linux archive.
The service binds to loopback and uses its own mines home.

  --runtime-dir DIR       Extracted archive containing mines
  --home-dir DIR          Runtime state (default: ~/.local/share/mines-host)
  --workdir DIR           Project checkout directory (default: ~/mines-projects)
  --port PORT             Loopback HTTP port (default: 3773)
  --environment-file FILE Optional provider/control configuration
  --print                Print the unit without installing or starting it
  --start                Enable and start after installation
  --help                 Show this help

Run as the account that owns the projects and provider logins, without sudo.
Paths must be absolute, without control characters or backslashes, and must not end with a space.
The runtime directory cannot contain quote characters.
EOF
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
systemd_quote() {
  printf '"'
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
  printf '"'
}
systemd_path() { printf '%s' "$1" | sed 's/%/%%/g'; }
absolute_path() {
  case "$1" in /*) ;; *) fail "Expected an absolute path: $1" ;; esac
  case "$1" in *[[:cntrl:]]*) fail 'Paths must not contain control characters.' ;; esac
  case "$1" in *\\*|*' ')
    fail 'Service paths must not contain backslashes or end with a space.' ;;
  esac
}

runtime_dir=
state_dir="$HOME/.local/share/mines-host"
work_dir="$HOME/mines-projects"
environment_file=
port=3773
print_only=false
start=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-dir|--home-dir|--workdir|--port|--environment-file)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --runtime-dir) runtime_dir=$2 ;;
        --home-dir) state_dir=$2 ;;
        --workdir) work_dir=$2 ;;
        --port) port=$2 ;;
        --environment-file) environment_file=$2 ;;
      esac
      shift 2 ;;
    --print) print_only=true; shift ;;
    --start) start=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[ -n "$runtime_dir" ] || fail 'Pass --runtime-dir with the extracted archive directory.'
case "$port" in ''|*[!0-9]*|0|0*) fail 'Port must be an integer from 1 to 65535.' ;; esac
[ "$port" -le 65535 ] 2>/dev/null || fail 'Port must be an integer from 1 to 65535.'
for target in "$runtime_dir" "$state_dir" "$work_dir"; do absolute_path "$target"; done
[ -z "$environment_file" ] || absolute_path "$environment_file"
case "$runtime_dir" in *\"*|*\'*) fail 'Runtime directory must not contain quote characters.' ;; esac
[ -x "$runtime_dir/mines" ] || fail 'Runtime directory must contain the mines executable.'
runtime_dir=$(cd "$runtime_dir" && pwd -P)
absolute_path "$runtime_dir"
case "$runtime_dir" in *\"*|*\'*) fail 'Runtime directory must not contain quote characters.' ;; esac
case "$PATH" in *[[:cntrl:]]*) fail 'PATH must not contain control characters.' ;; esac

render_unit() {
  cat <<EOF
[Unit]
Description=mines headless host
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
UMask=0077
WorkingDirectory=$(systemd_path "$work_dir")
Environment=$(systemd_quote "PATH=$PATH")
Environment=$(systemd_quote "MINES_HOME=$state_dir")
EOF
  if [ -n "$environment_file" ]; then
    printf 'EnvironmentFile=%s\n' "$(systemd_path "$environment_file")"
  fi
  # The colon disables systemd variable substitution in literal filesystem paths.
  printf 'ExecStart=:%s serve --base-dir %s --host 127.0.0.1 --port %s --no-browser\n' \
    "$(systemd_quote "$runtime_dir/mines")" "$(systemd_quote "$state_dir")" "$port"
  cat <<'EOF'
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=2
KillMode=mixed
TimeoutStopSec=90

[Install]
WantedBy=default.target
EOF
}

if "$print_only"; then render_unit; exit 0; fi
[ "$(uname -s)" = Linux ] || fail 'Installation requires Linux with user systemd.'
[ "$(id -u)" -ne 0 ] || fail 'Run as the project owner without sudo.'
command -v systemctl >/dev/null || fail 'systemctl is required.'
[ -z "$environment_file" ] || [ -r "$environment_file" ] || fail 'Environment file is not readable.'
systemctl --user show-environment >/dev/null
unit_dir="$HOME/.config/systemd/user"
umask 077
mkdir -p "$unit_dir" "$state_dir" "$work_dir"
unit_path="$unit_dir/mines-host.service"
unit_temp=$(mktemp "$unit_path.XXXXXX")
trap 'rm -f "$unit_temp"' 0
render_unit > "$unit_temp"
mv -f "$unit_temp" "$unit_path"
systemctl --user daemon-reload
if "$start"; then systemctl --user enable --now mines-host.service; fi
printf 'Installed %s\n' "$unit_path"
printf '%s\n' 'Start: systemctl --user enable --now mines-host.service' \
  'Logs: journalctl --user -u mines-host.service -f' \
  'Stop: systemctl --user stop mines-host.service'
