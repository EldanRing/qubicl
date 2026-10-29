#!/bin/bash
set -euo pipefail

# A fresh minimal home needs the standard XDG locations used by GTK/KDE apps.
# In particular, Kdenlive's media browser otherwise receives an empty Documents
# location and blocks startup with a file:// error. Preserve existing choices.
: "${HOME:?HOME must name the workload home}"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
if [[ -e "$config_root/user-dirs.dirs" || -L "$config_root/user-dirs.dirs" ]]; then
  exit 0
fi
umask 077
mkdir -p "$config_root"
desktop_config_tmp=$(mktemp "$config_root/.user-dirs.XXXXXX")
trap 'rm -f "$desktop_config_tmp"' EXIT
keys=(DESKTOP DOWNLOAD TEMPLATES PUBLICSHARE DOCUMENTS MUSIC PICTURES VIDEOS)
directories=(Desktop Downloads Templates Public Documents Music Pictures Videos)
for index in "${!keys[@]}"; do
  directory="${directories[$index]}"
  suffix="/$directory"
  if [[ ( -e "$HOME/$directory" || -L "$HOME/$directory" ) && ! -d "$HOME/$directory" ]]; then
    # An existing ordinary file or broken symlink is user data. Use the home
    # for this location instead of overwriting it or blocking desktop startup.
    suffix=''
  else
    mkdir -p "$HOME/$directory"
  fi
  printf 'XDG_%s_DIR="$HOME%s"\n' "${keys[$index]}" "$suffix" >> "$desktop_config_tmp"
done
mv -n "$desktop_config_tmp" "$config_root/user-dirs.dirs"
