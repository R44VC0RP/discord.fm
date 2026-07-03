#!/bin/sh
# anomaly.fm TV encoder: station art + audio-reactive waveform + live status
# text, encoded once and simulcast to every configured RTMP destination.
set -u

AUDIO_URL="${TV_AUDIO_URL:-http://icecast:8000/radio}"
ONAIR_FILE="${TV_ONAIR_FILE:-/feed/onair.txt}"
VBITRATE="${TV_VIDEO_BITRATE:-2500k}"
ABITRATE="${TV_AUDIO_BITRATE:-128k}"
FPS="${TV_FPS:-24}"
GOP=$((FPS * 2)) # 2s keyframe interval, per platform recommendations

# The bot writes the on-air line; wait for it so drawtext has a file to read.
while [ ! -f "$ONAIR_FILE" ]; do
  echo "[tv] waiting for $ONAIR_FILE (bot not up yet)"
  sleep 3
done

FILTER="[1:a]asplit=2[aout][awave];\
[awave]showwaves=s=520x150:mode=cline:rate=${FPS}:colors=0x3e968f[waves];\
[0:v][waves]overlay=96:470[v1];\
[v1]drawbox=x=96:y=658:w=16:h=16:color=0x3e968f:t=fill:enable='lt(mod(t\,1.7)\,0.85)'[v2];\
[v2]drawtext=textfile=${ONAIR_FILE}:reload=1:fontfile=/app/font.ttf:fontsize=30:fontcolor=0x17140f:x=126:y=648[vout]"

INPUTS="-re -loop 1 -framerate $FPS -i /app/tv.png \
  -user_agent anomalyfm-internal -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -i $AUDIO_URL"

ENCODE="-map [vout] -map [aout] \
  -c:v libx264 -preset superfast -pix_fmt yuv420p -r $FPS -g $GOP \
  -b:v $VBITRATE -maxrate $VBITRATE -bufsize 5000k \
  -c:a aac -b:a $ABITRATE -ar 44100 -ac 2 \
  -flags +global_header"

if [ "${TV_TEST:-}" = "1" ]; then
  echo "[tv] TEST MODE: rendering 20s to /out/tv-test.mp4"
  # shellcheck disable=SC2086
  exec ffmpeg -hide_banner -loglevel warning $INPUTS \
    -filter_complex "$FILTER" $ENCODE -t 20 -y /out/tv-test.mp4
fi

# Single encode into the local relay; per-platform pushers (push-yt, push-x)
# pull from there with -c copy, so one platform can restart without the other
# (or this encoder) noticing.
RELAY="${TV_RELAY_URL:-rtmp://mediamtx:1935/tv}"
echo "[tv] encoding to relay: $RELAY"
while true; do
  # shellcheck disable=SC2086
  ffmpeg -hide_banner -loglevel warning $INPUTS \
    -filter_complex "$FILTER" $ENCODE -f flv "$RELAY"
  echo "[tv] encoder exited (code $?); restarting in 3s"
  sleep 3
done
