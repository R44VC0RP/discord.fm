#!/bin/sh
# Repeated real-decoder + deterministic transient-settlement soak (15m default).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DURATION=${PLAYOUT_SOAK_SECONDS:-900}
START=$(date +%s)
ITERATION=0
UNEXPECTED_TICK_FAILURES=0
while :; do
  NOW=$(date +%s)
  [ $((NOW-START)) -ge "$DURATION" ] && break
  ITERATION=$((ITERATION+1))
  printf 'playout soak iteration %s (elapsed %ss)\n' "$ITERATION" "$((NOW-START))"
  if OUTPUT=$(cd "$ROOT/bot" && node --import tsx --test --test-name-pattern='station ident smoothly|live-human master duck|station overlay admission|legacy rerun announcement|real A-B-C decoder lifecycle|DJ enqueue racing a deterministic rerun|dropped committed claim|restart after unrecoverable claim|claim ambiguity deadline|transient complete failure' test/program.test.ts 2>&1); then
    printf '%s\n' "$OUTPUT"
  else
    printf '%s\n' "$OUTPUT"
    exit 1
  fi
  case "$OUTPUT" in
    *'playout tick failed'*)
      UNEXPECTED_TICK_FAILURES=$((UNEXPECTED_TICK_FAILURES+1))
      printf 'unexpected playout-tick failure detected\n' >&2
      exit 1
      ;;
  esac
done
END=$(date +%s)
printf 'PASS: %s playout iterations over %ss; unexpected_tick_failures=%s\n' "$ITERATION" "$((END-START))" "$UNEXPECTED_TICK_FAILURES"
