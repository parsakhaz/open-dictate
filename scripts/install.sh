#!/usr/bin/env bash
# Install or update a checksum-verified Dictate release without Node or administrator rights.
set -euo pipefail

fail() { printf 'Dictate: %s\n' "$*" >&2; exit 1; }
version="${DICTATE_VERSION:-}"
from=""
repo="${DICTATE_REPOSITORY:-parsakhaz/experiments}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail '--version requires X.Y.Z'; version="$2"; shift 2 ;;
    --from) [ "$#" -ge 2 ] || fail '--from requires a release directory'; from="$2"; shift 2 ;;
    --help) printf '%s\n' 'Usage: bash install.sh [--version X.Y.Z] [--from RELEASE_DIRECTORY]' 'Private repository: opt in with DICTATE_USE_GH=1 (authenticated gh), or DICTATE_GITHUB_TOKEN plus gh.'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'Invalid DICTATE_REPOSITORY'
use_gh="${DICTATE_USE_GH:-0}"
if [ -n "${DICTATE_GITHUB_TOKEN:-}" ]; then export GH_TOKEN="$DICTATE_GITHUB_TOKEN"; use_gh=1; fi
if [ "$use_gh" = 1 ]; then command -v gh >/dev/null || fail 'Private downloads require GitHub CLI (gh)'; fi
if [ -z "$version" ]; then
  [ -z "$from" ] || fail '--from requires --version'
  if [ "$use_gh" = 1 ]; then
    tag="$(gh release list --repo "$repo" --limit 100 --json tagName,isPrerelease,isDraft --jq '[.[] | select(.isDraft == false and .isPrerelease == false and (.tagName | test("^dictate-v[0-9]+\\.[0-9]+\\.[0-9]+$")))][0].tagName')"
  else
    command -v curl >/dev/null || fail 'curl is required'
    command -v python3 >/dev/null || fail 'Automatic version discovery requires python3; pass --version X.Y.Z or opt in to gh with DICTATE_USE_GH=1'
    tag="$(curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "https://api.github.com/repos/$repo/releases?per_page=100" | python3 -c 'import json,re,sys; releases=json.load(sys.stdin); print(next((r["tag_name"] for r in releases if not r.get("draft") and not r.get("prerelease") and re.fullmatch(r"dictate-v[0-9]+\.[0-9]+\.[0-9]+",r.get("tag_name",""))),""))')"
  fi
  [[ "$tag" == dictate-v* ]] || fail 'No Dictate release found; pass --version X.Y.Z (private repositories require DICTATE_USE_GH=1)'
  version="${tag#dictate-v}"
fi
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Version must be X.Y.Z'
tag="dictate-v$version"
case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) fail 'Use install.ps1 on Windows; this installer supports macOS and Linux' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'Supported architectures: x64 and arm64' ;;
esac
if [ "$os" = macos ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
if [ "$os" = macos ]; then asset="Dictate-$version-macos-$arch.zip"; else asset="Dictate-$version-linux-$arch.AppImage"; fi
work="$(mktemp -d "${TMPDIR:-/tmp}/dictate-install.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT
fetch() {
  local name="$1"
  if [ -n "$from" ]; then
    [ -f "$from/$name" ] || fail "Missing release asset $from/$name"
    cp "$from/$name" "$work/$name"
  elif [ "$use_gh" = 1 ]; then
    gh release download "$tag" --repo "$repo" --pattern "$name" --dir "$work"
  else
    curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "https://github.com/$repo/releases/download/$tag/$name" -o "$work/$name"
  fi
}
fetch SHA256SUMS
fetch "$asset"
expected="$(awk -v wanted="$asset" '$2 == wanted { print $1 }' "$work/SHA256SUMS")"
[[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] || fail "Missing or duplicate checksum for $asset"
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$work/$asset")"; actual="${actual%% *}";
elif command -v shasum >/dev/null; then actual="$(shasum -a 256 "$work/$asset")"; actual="${actual%% *}";
else fail 'sha256sum or shasum is required'; fi
[ "$actual" = "$expected" ] || fail 'Checksum mismatch; the existing installation has not been changed'

if [ "$os" = macos ]; then
  apps="${DICTATE_APPLICATIONS_DIR:-$HOME/Applications}"
  mkdir -p "$apps"
  staged="$(mktemp -d "$apps/.dictate-install.XXXXXXXX")"
  # ditto preserves app bundle metadata and code signatures, including paths with spaces.
  if ! ditto -x -k "$work/$asset" "$staged"; then rm -rf "$staged"; fail 'Could not extract the app'; fi
  [ -x "$staged/Dictate.app/Contents/MacOS/Dictate" ] || { rm -rf "$staged"; fail 'Release does not contain Dictate.app'; }
  backup="$apps/.Dictate.previous.$$"
  if [ -e "$apps/Dictate.app" ]; then mv "$apps/Dictate.app" "$backup"; fi
  if ! mv "$staged/Dictate.app" "$apps/Dictate.app"; then
    [ ! -e "$backup" ] || mv "$backup" "$apps/Dictate.app"
    rm -rf "$staged"; fail 'Could not install the app; previous app restored'
  fi
  rm -rf "$staged" "$backup"
  printf 'Installed Dictate %s: %s/Dictate.app\nOpen it from Finder; macOS may ask you to approve this unsigned testing build in Privacy & Security.\n' "$version" "$apps"
else
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  bins="${DICTATE_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$data/dictate" "$data/applications" "$bins"
  target="$data/dictate/$asset"
  staged="$(mktemp "$data/dictate/.download.XXXXXXXX")"
  cp "$work/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$target"
  launcher="$(mktemp "$bins/.dictate.XXXXXXXX")"
  { printf '#!/usr/bin/env bash\nexport APPIMAGE_EXTRACT_AND_RUN=1\nexec '; printf '%q' "$target"; printf ' "$@"\n'; } > "$launcher"
  chmod 755 "$launcher"
  mv -f "$launcher" "$bins/dictate"
  # Desktop entry Exec follows freedesktop escaping, which differs from shell escaping.
  exec_path="${bins//\\/\\\\}/dictate"; exec_path="${exec_path//\"/\\\"}"; exec_path="${exec_path//\$/\\\$}"; exec_path="${exec_path//\`/\\\`}"
  exec_path="${exec_path//%/%%}"
  printf '[Desktop Entry]\nType=Application\nName=Dictate\nComment=Local speech-to-text dictation\nExec="%s"\nTerminal=false\nCategories=Utility;\nStartupWMClass=org.dictate.Dictate\n' "$exec_path" > "$data/applications/org.dictate.Dictate.desktop"
  printf 'Installed Dictate %s: %s\nLaunch Dictate from your applications menu or run "%s/dictate".\n' "$version" "$target" "$bins"
  printf '%s\n' 'Linux requires a desktop session and Electron system libraries; Ubuntu/Debian users can use the .deb package for system integration.'
fi
