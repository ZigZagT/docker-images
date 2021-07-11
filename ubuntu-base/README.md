# Ubuntu Base

A minimal ubuntu images with life-quality-improvements built in.

```bash
docker pull deaddev/ubuntu-base
```

## Usage

1. Timezone can be set via `TZ` environment variable. Supports both build time and run time.
    - for build time, set `build-arg` like `docker build --build-arg TZ=America/Vancouver`
    - for run time, set `environment` like `docker run -e TZ=America/Vancouver`
2. Set apt mirror via `APT_MIRROR` environment variable. Also supports both build time and run time:
    - for build time, set `build-arg` like `docker build --build-arg APT_MIRROR=us.archive.ubuntu.com`
    - for run time, set `environment` like `docker run -e APT_MIRROR=us.archive.ubuntu.com`
    - you may find a mirror from https://launchpad.net/ubuntu/+archivemirrors
3. Set `UID` and `GID` environment variables to switch to an arbitrary user settings.
    - Note: When using this feature, make sure your container process has the permission to change user/group.
4. Disabled installing recommends and suggests for `apt-get`.
5. HTTP ready. `curl` and `wget` are included in the image.

Both `TZ` and `APT_MIRROR` works with non-root user. So you can freely use `USER` command in `Dockerfile`.

### Use Custom `ENTRYPOINT`

This image comes with an `ENTRYPOINT` script to achive all the run-time features listed above (build time features are not affected). To make everything work with an custom `ENTRYPOINT` script, use this command in your `ENTRYPOINT` script where you're about to starting the container command:

```sh
// equivalent to exec "$@"
/container-setup/entrypoint.sh "$@"
```

This usually replaces `exec "$@"` in a typical `ENTRYPOINT` script.

## Caveats

Make sure you run `rm -f /container-setup/*` if you're not using the bundled `/container-setup/entrypoint.sh` script at all.

In order to make `TZ` and `APT_MIRROR` working with non-root user, `SETUID` bit was set on the script files. This can pose a security risk. To eliminates the risk you need to remove `SETUID` enabled scripts at container launch time. This is handled by the bundled `entrypoint.sh`.

`/container-setup/` has `rwx` permission to allow deletion by any non-root users.

## Geoip variant
The `:geoip` tag is a version includes the common MaxMind GeoLite databases. Including:
- `/usr/share/GeoIP/GeoLite2-ASN.mmdb`
- `/usr/share/GeoIP/GeoLite2-City.mmdb`
- `/usr/share/GeoIP/GeoLite2-Country.mmdb`

## Troubleshooting

### Permission Denined for `/dev/stdout` and `/dev/stderr`

This happens when a container initializes with root user and then drop to non-root internally. (i.e. with `UID` and `GID` environments)

https://github.com/moby/moby/issues/31243#issuecomment-406879017

Workaround 1: use tty for the container.

`docker run --tty`

or add `tty: true` to docker-compose file.

Workaround 2:

https://github.com/moby/moby/issues/6880#issuecomment-270723812

Run this snippet prior to your CMD

```
mkfifo -m 600 /tmp/logpipe
cat <> /tmp/logpipe 1>&2 &

```

and then write to `/tmp/logpipe`

