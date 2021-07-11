#!/bin/bash
set -e

/container-setup/setup-tz.sh.x
/container-setup/setup-apt.sh.x

# remove the setuid enabled executables for security
rm -f /container-setup/*

if [[ $EUID -ne 0 ]]; then
    exec "$@"
else
    setpriv --groups=tty --regid ${GID:-$(id -g)} --reuid ${UID:-$(id -u)} "$@"
fi

