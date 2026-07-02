#!/bin/sh
set -eu

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD must be set}"
: "${ICECAST_ADMIN_PASSWORD:?ICECAST_ADMIN_PASSWORD must be set}"

export ICECAST_SOURCE_PASSWORD
export ICECAST_ADMIN_PASSWORD
export ICECAST_RELAY_PASSWORD="${ICECAST_RELAY_PASSWORD:-$ICECAST_SOURCE_PASSWORD}"
export ICECAST_HOSTNAME="${ICECAST_HOSTNAME:-localhost}"
export ICECAST_MAX_CLIENTS="${ICECAST_MAX_CLIENTS:-250}"

envsubst < /etc/icecast2/icecast.xml.tpl > /tmp/icecast.xml

exec icecast2 -c /tmp/icecast.xml
