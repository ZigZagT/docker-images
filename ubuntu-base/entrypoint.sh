#!/bin/bash
set -e

# skip the initialization in case of contaienr restarts
if [[ ! -f /container-setup/CONTAINER_HAS_STARTED ]]; then
    /container-setup/setup-tz.sh.x
    /container-setup/setup-apt.sh.x
    # remove the setuid enabled executables for security
    rm -f /container-setup/*.sh.x
fi
echo 1 > /container-setup/CONTAINER_HAS_STARTED

exec "$@"
