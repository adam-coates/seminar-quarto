#!/usr/bin/env bash
# Render the test decks and the demo deck with this checkout's extension,
# start a local relay and two web servers, and run the browser suites.
#
#   tests/run.sh                 # every suite
#   tests/run.sh polls hide      # just these
#
# Needs quarto, node (run `npm ci` in tests/ first), python3 and Chrome or
# Chromium (CHROME_PATH, default /usr/bin/chromium). Logs and screenshots go
# to tests/out/ (OUT_DIR). Exits non-zero if any suite fails.
set -uo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$TESTS")
QUARTO=${QUARTO:-quarto}
export OUT_DIR=${OUT_DIR:-$TESTS/out}

# The test decks (tests/decks) are served on 8081, the repo's demo deck on
# 8080; the relay listens on 4433. Both decks use the room password "test".
DECK_SUITES=(polls kinds session misc rounds_quiz fixes baseline device filter)
DEMO_SUITES=(print hide hostvote3 demo bar_off)
HASH='$2a$05$PP2N6d07kWQNp3VLSn.w3OmfUd/fuVJ8U5vHdA3ku/hdRgMy3Vlp.' # bcrypt("test")

WORK=$(mktemp -d)
pids=()
cleanup() {
  ((${#pids[@]})) && kill "${pids[@]}" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
rm -rf "$OUT_DIR" && mkdir -p "$OUT_DIR"

# ---- render ----------------------------------------------------------------
echo "== rendering"
cp -r "$TESTS/decks" "$WORK/decks"
mkdir -p "$WORK/decks/_extensions"
cp -r "$ROOT/_extensions/adam-coates" "$WORK/decks/_extensions/"
mkdir -p "$WORK/demo"
cp -r "$ROOT/_quarto.yml" "$ROOT/index.qmd" "$ROOT/images" "$ROOT/_extensions" "$WORK/demo/"
# the demo deck points at a real server; send it to the local relay instead
sed -i -E "s#^(  server: ).*#\1\"http://localhost:4433/\"#; s#^(  hash: ).*#\1\"$HASH\"#" "$WORK/demo/index.qmd"
grep -qF 'server: "http://localhost:4433/"' "$WORK/demo/index.qmd" && grep -qF "$HASH" "$WORK/demo/index.qmd" ||
  { echo "could not point index.qmd at the local relay"; exit 1; }
for site in decks demo; do
  (cd "$WORK/$site" && "$QUARTO" render >"$OUT_DIR/render-$site.log" 2>&1) ||
    { cat "$OUT_DIR/render-$site.log"; echo "render of $site failed"; exit 1; }
done

# ---- serve -----------------------------------------------------------------
echo "== starting relay and web servers"
PORT=4433 node "$TESTS/relay/server.js" >"$OUT_DIR/relay.log" 2>&1 & pids+=($!)
python3 -m http.server 8081 --bind 127.0.0.1 --directory "$WORK/decks" >"$OUT_DIR/http-decks.log" 2>&1 & pids+=($!)
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$WORK/demo" >"$OUT_DIR/http-demo.log" 2>&1 & pids+=($!)
up() { node -e 'fetch(process.argv[1]).then(() => process.exit(0), () => process.exit(1))' "$1"; }
for _ in $(seq 50); do
  up http://localhost:4433/ && up http://localhost:8081/test.html && up http://localhost:8080/index.html && break
  sleep 0.2
done

# ---- run -------------------------------------------------------------------
wanted=("$@")
selected() { ((${#wanted[@]} == 0)) || [[ " ${wanted[*]} " == *" $1 "* ]]; }
failed=()
run() { # base suite
  selected "$2" || return 0
  local log="$OUT_DIR/$2.log"
  BASE=$1 timeout 300 node "$TESTS/suites/$2.js" >"$log" 2>&1
  local rc=$? ok fail
  ok=$(grep -c '^ok:' "$log")
  fail=$(grep -c '^FAIL' "$log")
  if ((rc != 0 || fail > 0)); then
    printf '  FAIL  %-12s %3d ok, %d failed (exit %d)\n' "$2" "$ok" "$fail" "$rc"
    grep -E '^FAIL|Error' "$log" | head -5 | sed 's/^/        /'
    failed+=("$2")
  else
    printf '  ok    %-12s %3d checks\n' "$2" "$ok"
  fi
}
echo "== suites"
for s in "${DECK_SUITES[@]}"; do run http://localhost:8081/ "$s"; done
for s in "${DEMO_SUITES[@]}"; do run http://localhost:8080/ "$s"; done

if ((${#failed[@]})); then
  echo "== ${#failed[@]} suite(s) failed: ${failed[*]} (logs in $OUT_DIR)"
  exit 1
fi
echo "== all suites passed"
