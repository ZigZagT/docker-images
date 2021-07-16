# Ubuntu Base

A minimal ubuntu images with life-quality-improvements built in.

```bash
docker pull deaddev/ubuntu-base
```

## Features

- Set timezone with `TZ` environment variable
- Set apt mirror via `APT_MIRROR` environment variable
- Set arbitrary `UID` and `GID` at contaienr starting time
- Set container process niceness with `NICE` environment variable
- No installing recommends and suggests from `apt-get`
- HTTP ready. `curl`, `wget`, and `ca-certificates` are included in the image

## Usage

### Set timezone with `TZ` environment variable

#### Build time usage

For build time, use `build-arg` to set the environment variable like `docker build --build-arg TZ=America/Vancouver`, and then add `RUN /container-setup/setup-apt.sh` in your `Dockerfile`.

#### Runtime usage

If you're not overriding the `ENTRYPOINT` comes with the image, you may simply set `environment` like `docker run -e TZ=America/Vancouver`. Everything would just work. And this even supports non-root users.

See the [Use Custom `ENTRYPOINT`](#use-custom-entrypoint) section for guides of using custom entrypoint script.

### Set apt mirror via `APT_MIRROR` environment variable

#### Build time usage

For build time, use `build-arg` to set the environment variable like `docker build --build-arg APT_MIRROR=http://archive.ubuntu.com/ubuntu/`, and then add `RUN /container-setup/setup-tz.sh` in your `Dockerfile`.

#### Runtime usage

If you're not overriding the `ENTRYPOINT` comes with the image, you may simply set `environment` like `docker run -e APT_MIRROR=http://archive.ubuntu.com/ubuntu/`. Everything would just work. And this even supports non-root users.

See the [Use Custom `ENTRYPOINT`](#use-custom-entrypoint) section for guides of using custom entrypoint script.

you may find a mirror near to you on https://launchpad.net/ubuntu/+archivemirrors

### Change `UID` and `GID` at run time

If you need to change `UID` and `GID` at container start time rather than with the `USER` command in `Dockerfile`, the `UID` and `GID` environment variables are just for you.

`UID` and `GID` settings are for runtime only.

- Upon starting, the container will switch to the arbitrary user and/or group specified by the `UID` and `GID` settings.
- You can specify either `UID`, or `GUI`, or both, non none. The freedom is yours.
- Note: when using this feature, make sure your container starting has the permission to switch user/group. This wouldn't be a problem if you don't use `USER` command in `Dockerfile`.

The `UID` and `GID` only works with the bundled `ENTRYPOINT`. See the [Use Custom `ENTRYPOINT`](#use-custom-entrypoint) section for guides of using custom entrypoint script.

## Set Niceness via `NICE` environment variable

You may set the `NICE` environment variable to an integer between `-20` to `19` to adjust the container process niceness.

Note: setting `NICE` to value lower than `0` would need both `CAP_SYS_NICE` capacity and root priviledge. A non-root user can only set `NICE` to a positive value. These are limitations posed by Linux kernel.

This feature needs the bundled `ENTRYPOINT`. See the [Use Custom `ENTRYPOINT`](#use-custom-entrypoint) section for guides of using custom entrypoint script.

## Use Custom `ENTRYPOINT`

The `ENTRYPOINT` script buneled with image is used for the features listed above. To make everything work with custom `ENTRYPOINT` script, use this command in your `ENTRYPOINT` script for starting the container process:

```sh
/container-setup/entrypoint.sh "$@"
```

You can think it as a equivalent of `exec "$@"`, but with all the perks provided by the image.

If you don't use `/container-setup/entrypoint.sh`, the container would run, but the features environment variables wouldn't be effective.

### Security Caveat

In order to make `TZ` and `APT_MIRROR` working with non-root user, `SETUID` bit was set on the scripts in `/container-setup/*.sh.x`. This may pose a security risk depends on your security requirements. To eliminates the risk you need to remove those scripts at container launch time. This is handled by the bundled `entrypoint.sh`.

A side-effect of this mitigation is that `/container-setup/` has `777` permission so it allow deletion of its content by any user.

In short, it's highly recommended to use the bundled `/container-setup/entrypoint.sh` at all time since it takes care of all the boilerplates.

The bottom line is you should at least run `rm -f /container-setup/*.sh.x` if you insist of not using `/container-setup/entrypoint.sh`.

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

