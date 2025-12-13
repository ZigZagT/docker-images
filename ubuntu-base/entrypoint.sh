#!/bin/bash
set -e

# skip the initialization in case of container restarts
if [[ ! -f /container-setup/CONTAINER_HAS_STARTED ]]; then
    /container-setup/setup-tz
    /container-setup/setup-apt
    # remove the setuid enabled executables for security
    rm -f /container-setup/setup-tz /container-setup/setup-apt
fi
echo 1 > /container-setup/CONTAINER_HAS_STARTED

exec "$@"
