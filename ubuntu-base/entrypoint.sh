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

nice -n ${NICE:-0} setpriv --groups=tty --regid ${GID:-$(id -g)} --reuid ${UID:-$(id -u)} "$@"

