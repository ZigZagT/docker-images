#!/bin/bash
set -e

# skip the initialization in case of contaienr restarts
if [[ ! -f /tmp/CONTAINER_HAS_STARTED ]]; then
    /container-setup/setup-tz.sh.x
    /container-setup/setup-apt.sh.x
    # remove the setuid enabled executables for security
    rm -f /container-setup/*.sh.x
fi
echo 1 > /tmp/CONTAINER_HAS_STARTED

CH_NICE=""
CH_UID=""
CH_GID=""

if [[ -n "$NICE" ]]; then
    CH_NICE="nice -n ${NICE}"
fi

if [[ -n "$UID" ]]; then
    CH_UID="--reuid ${UID}"
fi

if [[ -n "$GID" ]]; then
    CH_GID="--groups=tty --regid ${GID}"
fi

$CH_NICE setpriv $CH_UID $CH_GID "$@"

