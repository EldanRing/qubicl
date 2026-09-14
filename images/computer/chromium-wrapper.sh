#!/bin/sh
set -eu

launch_browser='eval "$(gnome-keyring-daemon --start --components=secrets)"; exec /usr/bin/chromium --password-store=gnome-libsecret "$@"'

# The session supervisor can run as root, but Chromium and its per-computer
# Secret Service always run as the ordinary workload user.
if [ "$(id -u)" = "$(id -u qubicl)" ]; then
  exec /usr/bin/dbus-run-session -- /bin/sh -c "$launch_browser" qubicl-browser "$@"
fi
exec /usr/bin/setpriv \
  --reuid=qubicl \
  --regid=qubicl \
  --init-groups \
  /usr/bin/dbus-run-session -- /bin/sh -c "$launch_browser" qubicl-browser "$@"
