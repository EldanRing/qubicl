#!/bin/sh
set -eu

# The session supervisor intentionally runs as root so its narrow internal
# credential cannot be read by desktop workloads. Chromium itself must run as
# the ordinary computer user: this preserves the process trust boundary and
# avoids running Chromium's large process tree as the trusted supervisor UID.
exec /usr/bin/setpriv \
  --reuid=qubicl \
  --regid=qubicl \
  --init-groups \
  /usr/bin/chromium "$@"
