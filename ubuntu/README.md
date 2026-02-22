# Ubuntu

Slighly unminimized Ubuntu images with quality-of-life improvements built in.
A few variants are available offering common build tools and runtimes.

```bash
docker pull deaddev/ubuntu
```

All images are built for **linux/amd64** and **linux/arm64** platforms.

### Supported Tags

| Tag | Content |
| --- | --- |
| `latest`, `24.04` | Ubuntu 24.04 Base |
| `26.04` | Ubuntu 26.04 Base |
| `22.04` | Ubuntu 22.04 Base |
| `node`, `nodejs`, `nodejs-24` | Node.js 24 on Latest Ubuntu (24.04) |
| `nodejs-22` | Node.js 22 on Latest Ubuntu (24.04) |
| `26.04-nodejs`, `26.04-nodejs-24` | Node.js 24 on Ubuntu 26.04 |
| `26.04-nodejs-22` | Node.js 22 on Ubuntu 26.04 |
| `24.04-nodejs`, `24.04-nodejs-24` | Node.js 24 on Ubuntu 24.04 |
| `24.04-nodejs-22` | Node.js 22 on Ubuntu 24.04 |
| `22.04-nodejs`, `22.04-nodejs-24` | Node.js 24 on Ubuntu 22.04 |
| `22.04-nodejs-22` | Node.js 22 on Ubuntu 22.04 |
| `26.04-rust` | Rust Stable on Ubuntu 26.04 |
| `rust` | Rust Stable on Latest Ubuntu (24.04) |
| `24.04-rust` | Rust Stable on Ubuntu 24.04 |
| `22.04-rust` | Rust Stable on Ubuntu 22.04 |

### End of Life (EOL)

EOL images are no longer updated and may be removed at any time.

| Tag | Content |
| --- | --- |
| `20.04` | Ubuntu 20.04 Base |
| `20.04-nodejs`, `20.04-nodejs-24` | Node.js 24 on Ubuntu 20.04 |
| `20.04-nodejs-22` | Node.js 22 on Ubuntu 20.04 |
| `20.04-rust` | Rust Stable on Ubuntu 20.04 |

## Features

- Set timezone with `TZ` environment variable
- Set apt mirror via `APT_MIRROR` environment variable
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

## Use Custom `ENTRYPOINT`

The `ENTRYPOINT` script buneled with image is used for the features listed above. To make everything work with custom `ENTRYPOINT` script, use this command in your `ENTRYPOINT` script for starting the container process:

```sh
/container-setup/entrypoint.sh "$@"
```

You can think it as a equivalent of `exec "$@"`, but with all the perks provided by the image.

If you don't use `/container-setup/entrypoint.sh`, the container would run, but the features environment variables wouldn't be effective.

### Security Caveat

To support `TZ` and `APT_MIRROR` configuration for non-root users, setuid binaries (`setup-apt` and `setup-tz`) are included in `/container-setup/`. These binaries can modify system files and pose a security risk depending on your requirements.

**Mitigation:** The bundled `entrypoint.sh` removes these setuid binaries after first container start. Use the bundled entrypoint to ensure proper cleanup.

**Minimum requirement:** If using a custom entrypoint, run `rm -f /container-setup/setup-apt /container-setup/setup-tz` after initialization.

**Note:** `/container-setup/` has `733` permissions (owner read/write/execute, group/others write/execute only) to allow deletion by any user while preventing directory listing.

## GeoIP Variant

For images with MaxMind GeoIP databases, see the separate [ubuntu-geoip](../ubuntu-geoip/README.md) image.
