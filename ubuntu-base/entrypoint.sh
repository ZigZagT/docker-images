#!/bin/bash
set -e

# skip the initialization in case of contaienr restarts
if [[ ! -f /tmp/CONTAINER_HAS_STARTED ]]; then
    /container-setup/setup-tz.sh.x
    /container-setup/setup-apt.sh.x
    # remove the setuid enabled executables for security
    rm -f /container-setup/*
fi
echo 1 > /tmp/CONTAINER_HAS_STARTED

if [[ $EUID -ne 0 ]]; then
    exec "$@"
else
    setpriv --groups=tty --regid ${GID:-$(id -g)} --reuid ${UID:-$(id -u)} "$@"
fi

