#!/usr/bin/env bash
set -e

/setup-tz.sh
/setup-apt.sh

setpriv --clear-groups --regid ${GID:-0} --reuid ${UID:-0} "$@"
