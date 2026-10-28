# Loaded by login shells; never changes service or viewer identities.
if [ "${USER:-}" = qubicl ]; then
  export VIRTUAL_ENV="$HOME/.local/share/qubicl/python/current"
  export npm_config_prefix="$HOME/.local"
  export PATH="$HOME/.local/bin:$VIRTUAL_ENV/bin:/opt/qubicl/skills-venv/bin:/usr/local/bin:/usr/bin:/bin"
fi
