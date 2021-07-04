#!/usr/bin/env bash
set -e

/setup-tz.sh
/setup-apt.sh

setpriv --groups=tty --regid ${GID:-0} --reuid ${UID:-0} "$@"
