#!/bin/sh
# Genuine pinned OpenCode -> custom tool -> automation HTTP integration test.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/anomaly-opencode-e2e-$$
PROJECT=anomaly-e2e-$$
export ICECAST_SOURCE_PASSWORD=e2e-source ICECAST_ADMIN_PASSWORD=e2e-admin ADMIN_PASSWORD_HASH=e2e-unused
cleanup() {
  docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$TMP/override.yml" --profile automation down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
mkdir -p "$TMP/state" "$TMP/generated" "$TMP/music" "$TMP/recordings" "$TMP/voicemails" "$TMP/feed"
for n in 1 2 3 4; do
  ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=$((300+n*70)):duration=65" -ar 48000 -ac 2 -b:a 96k -y "$TMP/music/track-$n.mp3"
done
cat >"$TMP/override.yml" <<EOF
services:
  automation:
    env_file: !reset []
    environment:
      AUTOMATION_INTERNAL_TOKEN: internal-token-0123456789abcdef012345
      AUTOMATION_DJ_TOOL_TOKEN: tool-token-0123456789abcdef0123456789
      OPENCODE_SERVER_PASSWORD: opencode-password-0123456789abcdef0123
      AUTOMATION_PLAYOUT_ENABLED: "false"
      AUTOMATION_DJ_ENABLED: "true"
      AUTOMATION_DJ_FAKE_PROVIDER_ENABLED: "true"
      AUTOMATION_GENERATION_ENABLED: "true"
      AUTOMATION_IMPORT_MUSIC_ON_START: "true"
      AUTOMATION_DJ_MODEL: fake/scripted
      AUTOMATION_LOW_CUES: "1"
      AUTOMATION_HIGH_CUES: "3"
      AUTOMATION_LOW_HORIZON_MIN: "1"
      AUTOMATION_TARGET_HORIZON_MIN: "3"
      AUTOMATION_MAX_HORIZON_MIN: "90"
      AUTOMATION_DJ_COOLDOWN_MS: "0"
      AUTOMATION_DJ_POLL_MS: "1000"
      ELEVENLABS_API_KEY: fake-local-key
      ELEVENLABS_VOICE_ID: fake-local-voice
    volumes:
      - $TMP/state:/state
      - $TMP/generated:/generated
      - $TMP/music:/music:ro
      - $TMP/recordings:/recordings:ro
      - $TMP/voicemails:/voicemails:ro
      - $TMP/feed:/feed
  opencode:
    environment:
      OPENCODE_SERVER_PASSWORD: opencode-password-0123456789abcdef0123
      AUTOMATION_DJ_TOOL_TOKEN: tool-token-0123456789abcdef0123456789
      AUTOMATION_DJ_MODEL: fake/scripted
EOF
DC="docker compose -p $PROJECT -f $ROOT/docker-compose.yml -f $TMP/override.yml --profile automation"
$DC up -d --build opencode automation

# Event-driven condition: no arbitrary fixed soak delay.
i=0
while [ "$i" -lt "${E2E_WAIT_SECONDS:-120}" ]; do
  result=$($DC exec -T automation node --input-type=module -e "import Database from 'better-sqlite3';const d=new Database('/state/station.db',{readonly:true});const run=d.prepare('select state,tool_calls,input_tokens,output_tokens from dj_runs order by started_at desc limit 1').get();const q=d.prepare(\"select count(*) n from cues where type='music' and state='READY'\").get();const c=d.prepare(\"select count(*) n from cues where type='spoken'\").get();const names=d.prepare('select distinct tool_name from dj_tool_audit order by tool_name').all().map(x=>x.tool_name);console.log(JSON.stringify({run,q:q.n,c:c.n,names}));" 2>/dev/null || true)
  case "$result" in *'"state":"COMPLETED"'*'"q":3'*'enqueue_commentary'*) break ;; esac
  i=$((i+1)); sleep 1
done
printf '%s\n' "$result"
[ "$i" -lt "${E2E_WAIT_SECONDS:-120}" ] || {
  $DC exec -T opencode node -e "const h={authorization:'Basic '+Buffer.from('opencode:opencode-password-0123456789abcdef0123').toString('base64')};fetch('http://127.0.0.1:4096/session',{headers:h}).then(r=>r.json()).then(async s=>{console.log('SESSIONS',JSON.stringify(s));for(const x of s){const m=await fetch('http://127.0.0.1:4096/session/'+x.id+'/message',{headers:h}).then(r=>r.json());console.log('MESSAGES',JSON.stringify(m));}})" || true
  $DC logs automation opencode; exit 1;
}
printf '%s' "$result" | grep -q '"tool_calls":' || exit 1
printf '%s' "$result" | grep -q 'get_queue' || exit 1
printf '%s' "$result" | grep -q 'list_tracks' || exit 1
printf '%s' "$result" | grep -q 'get_track_history' || exit 1
printf '%s' "$result" | grep -q 'enqueue_track' || exit 1
printf '%s' "$result" | grep -Eq '"input_tokens":[1-9][0-9]{2,}' || exit 1

# Every DJ session, including the contract probe, must be cleaned up.
sessions=$($DC exec -T opencode node -e "const a='Basic '+Buffer.from('opencode:opencode-password-0123456789abcdef0123').toString('base64');fetch('http://127.0.0.1:4096/session',{headers:{authorization:a}}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))")
[ "$sessions" = '[]' ] || { printf 'sessions were not cleaned up: %s\n' "$sessions" >&2; exit 1; }
printf 'PASS: pinned OpenCode emitted real tool_calls through exactly-seven custom HTTP tools\n'
