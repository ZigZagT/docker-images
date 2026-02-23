#!/usr/bin/env bash

# WAIT_FOR_START_SIGNAL: block until SIGUSR2, this allows programic configuration of the service
if [[ -n $WAIT_FOR_START_SIGNAL && ! -f /container-setup/START_SIGNAL_RECEIVED ]]; then
    sleep infinity &
    PID=$!
    trap 'trap SIGUSR2; echo start signal received; kill $PID' SIGUSR2
    echo 'waiting for start signal (SIGUSR2) ...'
    wait
    trap - SIGUSR2
fi
echo 1 > /container-setup/START_SIGNAL_RECEIVED
exec "$@"
