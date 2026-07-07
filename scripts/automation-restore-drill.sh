#!/bin/sh
# Isolated online-backup -> restored service drill. Never touches production.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/anomaly-restore-drill-$$
SOURCE=anomaly-restore-source-$$
RESTORED=anomaly-restore-target-$$
IMAGE=anomaly-automation-restore:local
TOKEN=restore-token-0123456789abcdef01234567
cleanup() { docker rm -f "$SOURCE" "$RESTORED" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
mkdir -p "$TMP/source" "$TMP/restore" "$TMP/music" "$TMP/generated" "$TMP/recordings" "$TMP/voicemails" "$TMP/feed"
chmod 0777 "$TMP/source" "$TMP/restore" "$TMP/generated" "$TMP/feed"
ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=65 -ar 48000 -ac 2 -b:a 96k -y "$TMP/music/restore-track.mp3"
docker build -t "$IMAGE" "$ROOT/automation" >/dev/null
run_service() {
  name=$1 state=$2 import=$3
  docker run -d --name "$name" \
    -e AUTOMATION_INTERNAL_TOKEN="$TOKEN" -e AUTOMATION_BIND=0.0.0.0 \
    -e AUTOMATION_DB_PATH=/state/station.db -e AUTOMATION_MUSIC_DIR=/music \
    -e AUTOMATION_GENERATED_DIR=/generated -e AUTOMATION_RECORDINGS_DIR=/recordings \
    -e AUTOMATION_VOICEMAILS_DIR=/voicemails -e AUTOMATION_FEED_DIR=/feed \
    -e AUTOMATION_IMPORT_MUSIC_ON_START="$import" \
    -e AUTOMATION_PLAYOUT_ENABLED=false -e AUTOMATION_DJ_ENABLED=false \
    -e AUTOMATION_GENERATION_ENABLED=false -e AUTOMATION_HOTLINE_ENABLED=false \
    -v "$state:/state" -v "$TMP/music:/music:ro" -v "$TMP/generated:/generated" \
    -v "$TMP/recordings:/recordings:ro" -v "$TMP/voicemails:/voicemails:ro" -v "$TMP/feed:/feed" "$IMAGE" >/dev/null
  i=0
  until docker exec "$name" node -e "fetch('http://127.0.0.1:8092/readyz').then(r=>{if(!r.ok)process.exit(1)})" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -lt 30 ] || { docker logs "$name"; exit 1; }; sleep 1
  done
}
run_service "$SOURCE" "$TMP/source" true
docker exec "$SOURCE" node -e "const h={authorization:'Bearer $TOKEN'};fetch('http://127.0.0.1:8092/internal/catalog',{headers:h}).then(r=>r.json()).then(async c=>{const q=await fetch('http://127.0.0.1:8092/internal/queue/tracks',{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({asset_id:c.items[0].asset_id,expected_queue_revision:0,idempotency_key:'restore:seed'})});if(!q.ok)process.exit(1)})"
BACKUP_JSON=$(docker exec "$SOURCE" node -e "fetch('http://127.0.0.1:8092/internal/maintenance/backup',{method:'POST',headers:{authorization:'Bearer $TOKEN','content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))")
BACKUP_PATH=$(printf '%s' "$BACKUP_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).path')
SOURCE_SIG=$(docker exec "$SOURCE" node --input-type=module -e "import Database from 'better-sqlite3';const d=new Database('/state/station.db',{readonly:true});console.log(JSON.stringify({revision:d.prepare('select revision from queue_meta').get().revision,assets:d.prepare('select id,content_sha256 from assets order by id').all(),cues:d.prepare('select count(*) n from cues').get().n,migration:d.prepare('select max(version) n from schema_migrations').get().n}))")
docker cp "$SOURCE:$BACKUP_PATH" "$TMP/restore/station.db" >/dev/null
docker rm -f "$SOURCE" >/dev/null
run_service "$RESTORED" "$TMP/restore" false
RESTORED_SIG=$(docker exec "$RESTORED" node --input-type=module -e "import Database from 'better-sqlite3';const d=new Database('/state/station.db',{readonly:true});const qc=d.pragma('quick_check')[0].quick_check;console.log(JSON.stringify({revision:d.prepare('select revision from queue_meta').get().revision,assets:d.prepare('select id,content_sha256 from assets order by id').all(),cues:d.prepare('select count(*) n from cues').get().n,migration:d.prepare('select max(version) n from schema_migrations').get().n,quick_check:qc}))")
EXPECTED=$(printf '%s' "$SOURCE_SIG" | node -pe 'const x=JSON.parse(require("fs").readFileSync(0,"utf8"));x.quick_check="ok";JSON.stringify(x)')
[ "$EXPECTED" = "$RESTORED_SIG" ] || { printf 'source: %s\nrestored: %s\n' "$EXPECTED" "$RESTORED_SIG" >&2; exit 1; }
printf 'PASS: restored isolated service %s\n' "$RESTORED_SIG"
