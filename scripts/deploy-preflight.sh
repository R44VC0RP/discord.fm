#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail() { printf 'deploy preflight: ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'deploy preflight: %s\n' "$*"; }

for pattern in '/state/' '/generated/' '/music/originals/' '/music/ready/'; do
  grep -Fqx "$pattern" .gitignore || fail ".gitignore is missing $pattern"
done
deploy_block=$(awk '/^rsync -az --delete/{copy=1} copy{print} copy && /anomaly.fm-discord\/$/{exit}' AGENTS.md)
[ -n "$deploy_block" ] || fail 'AGENTS.md has no canonical rsync --delete command'
for pattern in '--exclude "state/*"' '--exclude "generated/*"' '--exclude "music/originals/*"' '--exclude "music/ready/*"'; do
  printf '%s\n' "$deploy_block" | grep -Fq -- "$pattern" || fail "AGENTS.md canonical deploy command is missing $pattern"
done

tracked=$(git ls-files -- 'state/**' 'generated/**' 'music/originals/**' 'music/ready/**')
[ -z "$tracked" ] || fail "private durable paths are tracked by git: $tracked"

note 'protected target paths: state/* generated/* music/originals/* music/ready/*'
[ "${1:-}" = '--check-local' ] && exit 0
[ "$#" -eq 1 ] || fail 'usage: scripts/deploy-preflight.sh host:path (or --check-local)'

target=$1
host=${target%%:*}
remote=${target#*:}
[ "$host" != "$target" ] && [ -n "$host" ] && [ -n "$remote" ] || fail 'target must be host:path'
case "$host" in *[!A-Za-z0-9._@-]*) fail 'host contains unsafe shell characters' ;; esac
case "$remote" in *[!A-Za-z0-9._/-]*) fail 'remote path contains unsafe shell characters' ;; esac

if ssh "$host" "test -f '$remote/state/station.db'"; then
  note 'target DB exists; requesting online, integrity-checked backup from its sole writer'
  ssh "$host" "cd '$remote' && docker compose --profile automation exec -T automation node dist/backup-request.js" \
    || fail 'online SQLite backup failed; rsync is forbidden'
else
  status=$?
  [ "$status" -eq 1 ] || fail "could not inspect target over SSH (status $status)"
  note 'target has no state/station.db yet; no DB backup required'
fi

note 'PASS: durable paths are protected; run the documented rsync command unchanged'
