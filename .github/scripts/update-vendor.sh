#!/usr/bin/env bash
# Update the libraries in _extensions/adam-coates/livepoll/vendor/ to the
# newest npm release within each allowed range. Run from the repository root.
#
# Also refreshes each updated package's licence text (vendor/licenses/) and
# the licence named in vendor/README.md's table, flagging any change.
#
# Prints what changed. Under GitHub Actions it also sets the step outputs
# `changed` (true/false) and `summary` (markdown, one line per library).
#
# Ranges stay on the current major versions: the socket.io client must speak
# the relay server's protocol (4.x), and chart.js (the RevealChart plugin) is
# written against Chart.js 3's API. Moving to a new major is a manual job.
set -euo pipefail

EXT=_extensions/adam-coates/livepoll
VENDOR=$EXT/vendor

# package | npm range | file inside the package | vendored file
LIBS=(
  "socket.io-client|^4|dist/socket.io.min.js|socket.io.min.js"
  "chart.js|^3|dist/chart.min.js|chart.min.js"
  "reveal.js-plugins|^4|poll/style.css|poll-style.css"
)

# the version recorded in the vendor README's table, e.g. "chart.js 3.2.0"
current() { grep -oE "\| $(sed 's/\./\\./g' <<<"$1") [0-9]+\.[0-9]+\.[0-9]+" "$VENDOR/README.md" | head -1 | awk '{print $3}'; }
latest() { npm view "$1@$2" version --json | jq -r 'if type == "array" then .[] else . end' | sort -V | tail -1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

summary=""
declare -A now=()
for lib in "${LIBS[@]}"; do
  IFS='|' read -r pkg range src dest <<<"$lib"
  old=$(current "$pkg")
  new=$(latest "$pkg" "$range")
  [[ -n "$old" && -n "$new" ]] || { echo "could not read versions for $pkg (old='$old' new='$new')" >&2; exit 1; }
  now[$pkg]=$new
  if [[ "$old" == "$new" ]]; then
    echo "$pkg $old is current"
    continue
  fi
  echo "$pkg $old -> $new"
  # npm pack checks the tarball against the registry's integrity hash
  (cd "$work" && npm pack --silent "$pkg@$new" >/dev/null)
  mkdir -p "$work/$pkg"
  tar -xzf "$work"/*"-$new.tgz" -C "$work/$pkg"
  rm -f "$work"/*.tgz
  cp "$work/$pkg/package/$src" "$VENDOR/$dest"

  # licence: the package's own licence file, and the SPDX name in the table
  oldlic=$(grep -F "| \`$dest\` |" "$VENDOR/README.md" | awk -F'|' '{gsub(/^ +| +$/, "", $4); print $4}')
  newlic=$(jq -r '.license // "unknown"' "$work/$pkg/package/package.json")
  licfile=$(find "$work/$pkg/package" -maxdepth 1 -type f -iname 'licen[cs]e*' | sort | head -1)
  note=""
  if [[ -n "$licfile" ]]; then
    cp "$licfile" "$VENDOR/licenses/$pkg.txt"
  else
    note+=" ⚠️ no licence file in the package; \`licenses/$pkg.txt\` is the old one."
  fi
  [[ "$newlic" == "$oldlic" ]] || note+=" ⚠️ **licence changed: $oldlic → $newlic**"
  awk -v row="| \`$dest\` |" -v new="| \`$dest\` | $pkg $new (\`$src\`) | $newlic |" \
    'index($0, row) == 1 { print new; next } { print }' "$VENDOR/README.md" >"$work/README.md"
  mv "$work/README.md" "$VENDOR/README.md"

  summary+="- **$pkg** $old → $new ([changes](https://www.npmjs.com/package/$pkg/v/$new))$note"$'\n'
done

changed=false
if [[ -n "$summary" ]]; then
  changed=true
  s=${now[socket.io-client]} c=${now[chart.js]} r=${now[reveal.js-plugins]}
  # the dependency's version is part of its site_libs path, so a new one
  # makes browsers fetch the new files instead of using cached ones
  sed -i -E \
    -e "s/^(  -- )socket\.io-client [0-9.]+, chart\.js [0-9.]+, reveal\.js-plugins [0-9.]+$/\1socket.io-client $s, chart.js $c, reveal.js-plugins $r/" \
    -e "s/^(  version = \")[0-9.]+-[0-9.]+-[0-9.]+(\",)$/\1$s-$c-$r\2/" \
    "$EXT/livepoll.lua"
  grep -q "version = \"$s-$c-$r\"" "$EXT/livepoll.lua" || { echo "failed to update livepoll.lua" >&2; exit 1; }
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "changed=$changed"
    echo "summary<<EOF"
    printf '%s' "$summary"
    echo "EOF"
  } >>"$GITHUB_OUTPUT"
fi
