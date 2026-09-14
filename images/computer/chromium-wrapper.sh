#!/bin/sh
set -eu

launch_browser='
keyring_directory="${XDG_DATA_HOME:-$HOME/.local/share}/qubicl"
keyring_password_file="$keyring_directory/browser-keyring-password"
if [ -L "$keyring_password_file" ] || [ ! -f "$keyring_password_file" ] ||
   [ "$(stat -c %a "$keyring_password_file")" != 600 ] ||
   [ ! -r "$keyring_password_file" ] || [ ! -w "$keyring_password_file" ] ||
   ! grep -Eq "^[A-Za-z0-9+/]{43}=$" "$keyring_password_file"; then
  echo "Qubicl browser keyring credential is invalid at $keyring_password_file. Restore its 0600 regular file or restore the computer from backup." >&2
  exit 78
fi
keyring_password=$(cat "$keyring_password_file")
eval "$(printf "%s\n" "$keyring_password" | gnome-keyring-daemon --login)"
eval "$(gnome-keyring-daemon --start --components=secrets)"
unset keyring_password
exec /usr/bin/chromium --password-store=gnome-libsecret "$@"
'

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
