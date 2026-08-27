#!/bin/bash
set -euo pipefail

runtime_role="${QUBICL_RUNTIME_ROLE:-control}"
if [[ "$runtime_role" == egress || "$runtime_role" == web ]]; then
  exec node /opt/qubicl/control.mjs
fi

target_uid="${QUBICL_HOST_UID:-1000}"
target_gid="${QUBICL_HOST_GID:-1000}"
if [[ "$(id -g qubicl)" != "$target_gid" ]]; then
  groupmod --non-unique --gid "$target_gid" qubicl
fi
if [[ "$(id -u qubicl)" != "$target_uid" ]]; then
  usermod --non-unique --uid "$target_uid" --gid "$target_gid" qubicl
fi

expected_owner="${target_uid}:${target_gid}"
owner_marker=/home/qubicl/.qubicl-owner
initialized_marker=/home/qubicl/.qubicl-initialized
if [[ ! -d /home/qubicl ]]; then
  install -d -o qubicl -g qubicl /home/qubicl
fi
if [[ "${QUBICL_INITIALIZE_HOME:-0}" == 1 ]]; then
  if [[ -e "$owner_marker" ]]; then
    if [[ ! -f "$owner_marker" ]] || [[ -L "$owner_marker" ]] || [[ "$(cat "$owner_marker")" != "$expected_owner" ]]; then
      echo "Qubicl home ownership does not match this host (${expected_owner})." >&2
      echo "Stop this computer, then run: qubicl repair ownership ${QUBICL_NAME:-<name>}" >&2
      exit 78
    fi
  else
    if find /home/qubicl -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
      echo "Qubicl found a non-empty home without an ownership marker." >&2
      echo "Stop this computer, then run: qubicl repair ownership ${QUBICL_NAME:-<name>}" >&2
      exit 78
    fi
    runuser -u qubicl -- cp -a --no-preserve=ownership /etc/skel/. /home/qubicl/ 2>/dev/null || true
    runuser -u qubicl -- touch "$initialized_marker"
    printf '%s\n' "$expected_owner" >"$owner_marker"
    chown qubicl:qubicl "$owner_marker"
  fi
else
  for _ in $(seq 1 300); do
    [[ -e "$owner_marker" ]] && break
    sleep 0.1
  done
  if [[ ! -f "$owner_marker" ]] || [[ -L "$owner_marker" ]] || [[ "$(cat "$owner_marker" 2>/dev/null || true)" != "$expected_owner" ]]; then
    echo "Qubicl's isolated runtime could not verify the initialized durable home (${expected_owner})." >&2
    exit 78
  fi
fi
# Copying /etc/skel with archive semantics can inherit the skeleton directory's
# mode onto the mount root. Keep the managed user-home directory private while
# leaving all user-created contents and their modes untouched.
chmod 0700 /home/qubicl

baked_profile="${QUBICL_IMAGE_STARTUP_PROFILE:?image startup profile is missing}"
requested_profile="${QUBICL_STARTUP_PROFILE:-$baked_profile}"
if [[ "$requested_profile" != "$baked_profile" ]]; then
  echo "Qubicl startup profile mismatch: host requested ${requested_profile}, image provides ${baked_profile}." >&2
  exit 78
fi

pids=()
start_as_user() {
  user_network_env=()
  if [[ -v QUBICL_PROXY_URL ]]; then
    user_network_env+=(HTTP_PROXY="$QUBICL_PROXY_URL" HTTPS_PROXY="$QUBICL_PROXY_URL" http_proxy="$QUBICL_PROXY_URL" https_proxy="$QUBICL_PROXY_URL")
  fi
  runuser -u qubicl -- env -i \
    HOME=/home/qubicl USER=qubicl LOGNAME=qubicl SHELL=/bin/bash \
    PATH=/opt/qubicl/skills-venv/bin:/home/qubicl/.local/bin:/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    XDG_CONFIG_HOME=/home/qubicl/.config \
    XDG_DATA_HOME=/home/qubicl/.local/share \
    XDG_CACHE_HOME=/home/qubicl/.cache \
    XDG_RUNTIME_DIR=/tmp/qubicl-runtime \
    "${user_network_env[@]}" \
    "$@" &
  pids+=("$!")
}

start_control_as_user() {
  control_env=(
    HOME=/home/qubicl USER=qubicl LOGNAME=qubicl SHELL=/bin/bash
    PATH=/opt/qubicl/skills-venv/bin:/home/qubicl/.local/bin:/usr/local/bin:/usr/bin:/bin
    LANG=C.UTF-8 LC_ALL=C.UTF-8
    XDG_CONFIG_HOME=/home/qubicl/.config
    XDG_DATA_HOME=/home/qubicl/.local/share
    XDG_CACHE_HOME=/home/qubicl/.cache
    XDG_RUNTIME_DIR=/tmp/qubicl-runtime
    QUBICL_RUNTIME_ROLE=control
    QUBICL_ID="${QUBICL_ID:?}"
    QUBICL_NAME="${QUBICL_NAME:?}"
    QUBICL_INTERNAL_KEY="${QUBICL_INTERNAL_KEY:?}"
    QUBICL_CONTROL_PORT="${QUBICL_CONTROL_PORT:-3212}"
    QUBICL_EXPECTED_MANIFEST_SHA256="${QUBICL_EXPECTED_MANIFEST_SHA256:?}"
    QUBICL_EXECUTOR_URL="${QUBICL_EXECUTOR_URL:?}"
    QUBICL_EXECUTOR_KEY="${QUBICL_EXECUTOR_KEY:?}"
    QUBICL_EXECUTOR_HOST="${QUBICL_EXECUTOR_HOST:?}"
    QUBICL_PUBLIC_PREVIEW_BASE="${QUBICL_PUBLIC_PREVIEW_BASE:?}"
    QUBICL_INTERNAL_PREVIEW_BASE="${QUBICL_INTERNAL_PREVIEW_BASE:?}"
    QUBICL_BROKER_URL="${QUBICL_BROKER_URL:?}"
    QUBICL_BROKER_KEY="${QUBICL_BROKER_KEY:?}"
    QUBICL_WEB_URL="${QUBICL_WEB_URL:?}"
    QUBICL_WEB_KEY="${QUBICL_WEB_KEY:?}"
    QUBICL_AUDIT_PATH="${QUBICL_AUDIT_PATH:?}"
    QUBICL_RESOURCE_ENVELOPE_JSON="${QUBICL_RESOURCE_ENVELOPE_JSON:?}"
    QUBICL_POLICY_PATH="${QUBICL_POLICY_PATH:?}"
  )
  if [[ -v QUBICL_SESSION_URL ]]; then control_env+=(QUBICL_SESSION_URL="$QUBICL_SESSION_URL"); fi
  if [[ -v QUBICL_SESSION_KEY ]]; then control_env+=(QUBICL_SESSION_KEY="$QUBICL_SESSION_KEY"); fi
  if [[ -v QUBICL_MANIFEST_PATH ]]; then control_env+=(QUBICL_MANIFEST_PATH="$QUBICL_MANIFEST_PATH"); fi
  if [[ "${QUBICL_TOKEN_METRICS:-0}" == 1 ]]; then control_env+=(QUBICL_TOKEN_METRICS=1); fi
  if [[ -v DISPLAY ]]; then control_env+=(DISPLAY="$DISPLAY"); fi
  runuser -u qubicl -- env -i "${control_env[@]}" node /opt/qubicl/control.mjs &
  pids+=("$!")
}

start_internal_executor() {
  executor_env=(
    HOME=/root USER=root LOGNAME=root PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8
    QUBICL_RUNTIME_ROLE=executor
    QUBICL_LISTEN_HOST=127.0.0.1
    QUBICL_RUNNER_KEY="${QUBICL_EXECUTOR_KEY:?}"
    QUBICL_HOST_UID="$target_uid"
    QUBICL_HOST_GID="$target_gid"
    QUBICL_EXECUTOR_FENCE_UID="${QUBICL_EXECUTOR_FENCE_UID:-1}"
  )
  if [[ -v DISPLAY ]]; then executor_env+=(DISPLAY="$DISPLAY"); fi
  if [[ -v QUBICL_PROXY_URL ]]; then executor_env+=(QUBICL_PROXY_URL="$QUBICL_PROXY_URL"); fi
  if [[ -v QUBICL_WORKLOAD_ENV_JSON ]]; then executor_env+=(QUBICL_WORKLOAD_ENV_JSON="$QUBICL_WORKLOAD_ENV_JSON"); fi
  env -i "${executor_env[@]}" node /opt/qubicl/control.mjs &
  pids+=("$!")
}

start_internal_session() {
  session_env=(
    HOME=/root USER=root LOGNAME=root PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8
    QUBICL_RUNTIME_ROLE=session
    QUBICL_LISTEN_HOST=127.0.0.1
    QUBICL_RUNNER_KEY="${QUBICL_SESSION_KEY:?}"
    QUBICL_HOST_UID="$target_uid"
    QUBICL_HOST_GID="$target_gid"
    QUBICL_COMPATIBILITY="${QUBICL_COMPATIBILITY:?}"
    QUBICL_BROWSER_EXECUTABLE="${QUBICL_BROWSER_EXECUTABLE:-/usr/local/bin/qubicl-chromium}"
    QUBICL_POINTER_URL="${QUBICL_POINTER_URL:?}"
    DISPLAY="${DISPLAY:-:0}"
  )
  if [[ -v QUBICL_PROXY_URL ]]; then session_env+=(QUBICL_PROXY_URL="$QUBICL_PROXY_URL"); fi
  if [[ -v QUBICL_WORKLOAD_ENV_JSON ]]; then session_env+=(QUBICL_WORKLOAD_ENV_JSON="$QUBICL_WORKLOAD_ENV_JSON"); fi
  env -i "${session_env[@]}" node /opt/qubicl/control.mjs &
  pids+=("$!")
}

start_internal_web() {
  web_env=(
    HOME=/tmp USER=nobody LOGNAME=nobody PATH=/opt/qubicl/web-venv/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8
    QUBICL_RUNTIME_ROLE=web
    QUBICL_LISTEN_HOST=127.0.0.1
    QUBICL_RUNNER_KEY="${QUBICL_WEB_KEY:?}"
    QUBICL_NETWORK_POLICY="${QUBICL_NETWORK_POLICY:?}"
  )
  if [[ -v QUBICL_PROXY_URL ]]; then web_env+=(QUBICL_PROXY_URL="$QUBICL_PROXY_URL"); fi
  runuser -u nobody -- env -i "${web_env[@]}" node /opt/qubicl/control.mjs &
  pids+=("$!")
}

start_ssh() {
  install -d -m 0755 /run/sshd
  install -d -m 0700 -o qubicl -g qubicl /run/qubicl-ssh
  # The inherited system account is password-locked, which also blocks
  # public-key SSH. Password and interactive authentication remain disabled.
  passwd -d qubicl >/dev/null
  printf '%s\n' "${QUBICL_SSH_PUBLIC_KEY:?}" >/run/qubicl-ssh/authorized_keys
  chmod 0600 /run/qubicl-ssh/authorized_keys
  chown qubicl:qubicl /run/qubicl-ssh/authorized_keys
  ssh-keygen -A >/dev/null
  ssh_network_settings=()
  if [[ -v QUBICL_PROXY_URL ]]; then
    ssh_network_settings+=("SetEnv HTTP_PROXY=$QUBICL_PROXY_URL HTTPS_PROXY=$QUBICL_PROXY_URL http_proxy=$QUBICL_PROXY_URL https_proxy=$QUBICL_PROXY_URL")
  fi
  /usr/sbin/sshd -D -e \
    -o Port=2222 \
    -o ListenAddress=0.0.0.0 \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o PermitRootLogin=no \
    -o AllowUsers=qubicl \
    -o PubkeyAuthentication=yes \
    -o AuthorizedKeysFile=/run/qubicl-ssh/authorized_keys \
    -o AllowTcpForwarding=yes \
    -o GatewayPorts=no \
    -o PermitTunnel=no \
    -o X11Forwarding=no \
    "${ssh_network_settings[@]}" &
  pids+=("$!")
}

install -d -m 0700 -o qubicl -g qubicl /tmp/qubicl-runtime

start_display() {
  export DISPLAY="${DISPLAY:-:0}"
  # Docker creates a fresh named-volume root as root:root/0755. Xvfb runs as
  # the unprivileged computer user, so make only this conventional X11 socket
  # directory sticky/world-writable before it creates the shared socket.
  install -d -m 1777 /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix
  rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
  start_as_user Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp -ac
  for _ in $(seq 1 100); do
    if runuser -u qubicl -- xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then return; fi
    sleep 0.1
  done
  echo "Qubicl display did not become ready." >&2
  exit 1
}

start_viewer() {
  runuser -u qubicl -- env DISPLAY="$DISPLAY" xset s off -dpms >/dev/null 2>&1 || true
  start_as_user env DISPLAY="$DISPLAY" x11vnc -display "$DISPLAY" -forever -shared -viewonly -localhost -nopw -rfbport 5900 -o /tmp/x11vnc-view.log
  start_as_user env DISPLAY="$DISPLAY" x11vnc -display "$DISPLAY" -forever -shared -localhost -nopw -rfbport 5901 -o /tmp/x11vnc-control.log
  start_as_user websockify --web=/usr/share/novnc 6080 localhost:5900
  start_as_user websockify 6081 localhost:5901
}

if [[ "$runtime_role" == session || "$runtime_role" == computer ]]; then
case "$baked_profile" in
  file-system)
    unset DISPLAY
    ;;
  browser)
    start_display
    start_as_user env DISPLAY="$DISPLAY" dbus-run-session -- openbox-session
    start_viewer
    start_as_user env DISPLAY="$DISPLAY" chromium \
      --no-first-run \
      --no-default-browser-check \
      --remote-debugging-address=127.0.0.1 \
      --remote-debugging-port=9222 \
      --user-data-dir=/home/qubicl/.local/share/qubicl/browser-profile \
      about:blank
    ;;
  desktop|workstation)
    start_display
    start_as_user env DISPLAY="$DISPLAY" dbus-run-session -- startxfce4
    start_viewer
    ;;
  *)
    echo "Unknown Qubicl startup profile ${baked_profile}." >&2
    exit 78
    ;;
esac
fi

case "$runtime_role" in
  control)
    start_control_as_user
    ;;
  computer)
    start_internal_executor
    start_internal_web
    if [[ "$baked_profile" != file-system ]]; then start_internal_session; fi
    if [[ -v QUBICL_SSH_PUBLIC_KEY ]]; then start_ssh; fi
    start_control_as_user
    ;;
  executor)
    env QUBICL_RUNTIME_ROLE=executor node /opt/qubicl/control.mjs &
    pids+=("$!")
    ;;
  session)
    env QUBICL_RUNTIME_ROLE=session node /opt/qubicl/control.mjs &
    pids+=("$!")
    ;;
  ssh)
    start_ssh
    ;;
  *)
    echo "Unknown Qubicl runtime role ${runtime_role}." >&2
    exit 78
    ;;
esac

shutdown() {
  if (( ${#pids[@]} )); then
    kill "${pids[@]}" 2>/dev/null || true
    wait 2>/dev/null || true
  fi
}
trap shutdown TERM INT EXIT
wait -n "${pids[@]}"
exit 1
