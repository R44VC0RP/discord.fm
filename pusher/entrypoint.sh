#!/bin/sh
# Platform pusher: stream-copies the relay feed to one RTMP destination.
# Near-zero CPU (no re-encode). Optionally restarts itself daily at
# RESTART_AT (in RESTART_TZ) for platforms with max-broadcast-length limits
# (X caps live broadcasts at ~24h).
set -u

SRC="${SRC_URL:-rtmp://mediamtx:1935/tv}"
LABEL="${LABEL:-dest}"
RESTART_AT="${RESTART_AT:-}"       # e.g. "02:00"; empty disables
RESTART_TZ="${RESTART_TZ:-America/New_York}"

if [ -z "${DEST_URL:-}" ]; then
  echo "[push:$LABEL] no DEST_URL configured; idling"
  exec sleep infinity
fi

secs_until_restart() {
  [ -z "$RESTART_AT" ] && return 1
  now=$(date +%s)
  target=$(TZ="$RESTART_TZ" date -d "$RESTART_AT" +%s 2>/dev/null) || return 1
  if [ "$target" -le "$now" ]; then
    target=$(TZ="$RESTART_TZ" date -d "tomorrow $RESTART_AT" +%s) || return 1
  fi
  echo $((target - now))
}

while true; do
  if S=$(secs_until_restart); then
    echo "[push:$LABEL] pushing; scheduled restart in ${S}s ($RESTART_AT $RESTART_TZ)"
    timeout "$S" ffmpeg -hide_banner -loglevel warning \
      -i "$SRC" -c copy -f flv "$DEST_URL"
    code=$?
    if [ "$code" -eq 124 ]; then
      echo "[push:$LABEL] scheduled daily restart"
      continue
    fi
  else
    ffmpeg -hide_banner -loglevel warning -i "$SRC" -c copy -f flv "$DEST_URL"
    code=$?
  fi
  echo "[push:$LABEL] exited (code $code); reconnecting in 3s"
  sleep 3
done
