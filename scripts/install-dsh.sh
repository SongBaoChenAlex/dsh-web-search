#!/usr/bin/env bash
# Install the dsh-web-search plugins into a DeepSeek Harness (DSH) profile from this checkout.
#
# Usage:
#   scripts/install-dsh.sh                       # recommended set; picks/asks for the DSH profile
#   scripts/install-dsh.sh --all                 # every package
#   scripts/install-dsh.sh --profile cli search-governor search-http
#   SKIP_INSTALL=1 scripts/install-dsh.sh        # skip `pnpm install` (e.g. after git pull)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

profile=""
all=0
packages=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --all) all=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) packages+=("$1"); shift ;;
  esac
done

for tool in pnpm dsh; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH (pnpm: https://pnpm.io/installation, dsh: npm i -g @deepseek-ai/dsh)" >&2; exit 1; }
done

# --- Pick the DSH profile: --profile > the only existing profile > interactive choice > typed name ---
if [[ -z "$profile" ]]; then
  dsh_home="${DSH_HOME:-$HOME/.dsh}"
  profiles_dir="$dsh_home/profiles"
  existing=()
  if [[ -d "$profiles_dir" ]]; then
    for d in "$profiles_dir"/*/; do
      [[ -d "$d" ]] || continue
      name="$(basename "$d")"
      [[ "$name" == "node_modules" || "$name" == "desktop" ]] && continue
      [[ -f "$d/package.json" ]] && existing+=("$name")
    done
  fi
  if [[ ${#existing[@]} -eq 1 ]]; then
    profile="${existing[0]}"
    echo "Using the only DSH profile found: $profile  ($profiles_dir)"
  elif [[ ${#existing[@]} -gt 1 ]]; then
    echo "DSH profiles found in $profiles_dir:"
    for i in "${!existing[@]}"; do printf '  [%d] %s\n' "$((i+1))" "${existing[$i]}"; done
    default="${existing[0]}"; for e in "${existing[@]}"; do [[ "$e" == "web" ]] && default="web"; done
    read -r -p "Install into which profile? (number or name, Enter = $default) " answer
    if [[ -z "$answer" ]]; then profile="$default"
    elif [[ "$answer" =~ ^[0-9]+$ && "$answer" -ge 1 && "$answer" -le ${#existing[@]} ]]; then profile="${existing[$((answer-1))]}"
    else profile="$answer"; fi
  else
    echo "No DSH profile found under $profiles_dir."
    read -r -p "Profile name to create/use (Enter = web) " answer
    profile="${answer:-web}"
  fi
fi
[[ "${profile,,}" == "desktop" ]] && { echo "error: profile 'desktop' is managed by the DSH Electron app; pick another profile" >&2; exit 1; }
echo "Target profile: $profile"

if [[ $all -eq 1 ]]; then
  packages=()
  for d in packages/*/; do
    name="$(basename "$d")"
    [[ "$name" == "shared" ]] && continue
    [[ -f "$d/cordis.patch.yml" ]] && packages+=("$name")
  done
elif [[ ${#packages[@]} -eq 0 ]]; then
  packages=(search-governor search-http fetch-readability tavily-tools fetch-composite provider-selector)
fi

if [[ -z "${SKIP_INSTALL:-}" ]]; then
  echo "==> pnpm install"
  CI=true pnpm install --prefer-offline
fi

ok=(); failed=()
for name in "${packages[@]}"; do
  if [[ ! -f "packages/$name/package.json" ]]; then echo "warning: skip '$name': no such package" >&2; continue; fi
  echo "==> dsh plugin --profile $profile add ./packages/$name"
  if dsh plugin --profile "$profile" add "./packages/$name"; then ok+=("$name"); else failed+=("$name"); fi
done

echo
echo "Installed (${#ok[@]}): ${ok[*]:-}"
[[ ${#failed[@]} -gt 0 ]] && echo "Failed (${#failed[@]}): ${failed[*]}"
echo
echo "Next: restart DSH, open Settings > 'Web providers' in the Web GUI and enter your search API key (e.g. Tavily)."
echo "Update later with: git pull && SKIP_INSTALL= scripts/install-dsh.sh   (plugins are path-linked)."
[[ ${#failed[@]} -eq 0 ]]
