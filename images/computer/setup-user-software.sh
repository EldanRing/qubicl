#!/bin/bash
set -euo pipefail
# Invoked as the workload user. Never downloads packages during startup.
software_root="$HOME/.local/share/qubicl/python"
mkdir -p "$software_root" "$HOME/.local/bin"
exec 9>"$software_root/.setup.lock"
flock -x 9
python_abi="$(/usr/bin/python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
python_env="$software_root/$python_abi"
if [[ ! -f "$python_env/.qubicl-ready" ]]; then
  /usr/bin/python3 -m venv "$python_env"
  touch "$python_env/.qubicl-ready"
fi
if [[ -e "$software_root/current" && ! -L "$software_root/current" ]]; then
  echo "Qubicl Python environment: $software_root/current must be a symlink; existing data was preserved." >&2
  exit 78
fi
previous="$(readlink "$software_root/current" || true)"
if [[ "$previous" != "$python_abi" ]]; then
  ln -sfn "$python_abi" "$software_root/current"
  if [[ -n "$previous" ]]; then
    echo "Qubicl Python changed from $previous to $python_abi. The previous environment is preserved; reinstall its packages for the new interpreter." >&2
  fi
fi
