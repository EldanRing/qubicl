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
exec x11vnc \
  -inetd \
  -display "${DISPLAY:-:0}" \
  -rfbport 0 \
  -shared \
  -nopw \
  -noremote \
  -nocmds \
  -q \
  "${viewer_mode[@]}"
