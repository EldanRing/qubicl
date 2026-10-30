#!/bin/bash
set -euo pipefail

case "${0##*/}" in
  qubicl-x11vnc-view)
    viewer_mode=(-viewonly)
    ;;
  qubicl-x11vnc-control)
    viewer_mode=()
    ;;
  *)
    exit 64
    ;;
esac

# x11vnc's packaged Unix-listener support depends on a downstream libvncserver
# build detail. socat supplies a real connected socket on stdin/stdout instead,
# so inetd mode never opens a raw TCP RFB listener.
# The separate viewer user cannot attach Xvfb's workload-owned MIT-SHM segments.
# Ordinary X11 image reads preserve that user boundary for both viewer modes.
exec x11vnc \
  -inetd \
  -display "${DISPLAY:-:0}" \
  -rfbport 0 \
  -shared \
  -noshm \
  -nopw \
  -noremote \
  -nocmds \
  -q \
  "${viewer_mode[@]}"
