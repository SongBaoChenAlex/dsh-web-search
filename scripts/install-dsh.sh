#!/usr/bin/env bash
# Install the dsh-web-search plugins into a DeepSeek Harness (DSH) profile from this checkout.
#
# Usage:
#   scripts/install-dsh.sh                       # recommended set into profile "web"
#   scripts/install-dsh.sh --all                 # every package
#   scripts/install-dsh.sh --profile cli search-governor search-http
#   SKIP_INSTALL=1 scripts/install-dsh.sh        # skip `pnpm install` (e.g. after git pull)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

profile="web"
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
