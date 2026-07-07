#!/bin/sh
# Production-like --delete drill proving every private durable root survives.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/anomaly-rsync-drill-$$
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$TMP/source" "$TMP/target/state" "$TMP/target/generated" "$TMP/target/music/originals" "$TMP/target/music/ready"
printf source >"$TMP/source/README.md"
for file in state/station.db generated/render.mp3 music/originals/original.mp3 music/ready/ready.mp3; do
  printf 'durable:%s\n' "$file" >"$TMP/target/$file"
done
BEFORE=$(cd "$TMP/target" && shasum -a 256 state/station.db generated/render.mp3 music/originals/original.mp3 music/ready/ready.mp3)
rsync -az --delete --exclude node_modules --exclude dist --exclude .env --exclude .git \
  --exclude 'music/*' --exclude 'music/originals/*' --exclude 'music/ready/*' \
  --exclude 'state/*' --exclude 'generated/*' --exclude 'feed/*' \
  --exclude 'recordings/*' --exclude 'voicemails/*' --exclude 'web/current.html' \
  "$TMP/source/" "$TMP/target/"
AFTER=$(cd "$TMP/target" && shasum -a 256 state/station.db generated/render.mp3 music/originals/original.mp3 music/ready/ready.mp3)
[ "$BEFORE" = "$AFTER" ] || { printf 'durable hashes changed\n' >&2; exit 1; }
[ "$(cat "$TMP/target/README.md")" = source ]
printf 'PASS: canonical rsync --delete exclusions preserve all durable roots\n'
