#!/bin/sh
set -eu
test -n "${OPENCODE_SERVER_PASSWORD:-}" || { echo 'OPENCODE_SERVER_PASSWORD is required' >&2; exit 1; }
mkdir -p /scratch/home /scratch/work
cd /scratch/work
exec /opt/opencode/node_modules/.bin/opencode serve --hostname 0.0.0.0 --port 4096
