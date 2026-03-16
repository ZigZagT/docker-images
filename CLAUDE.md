# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A collection of Docker images built for linux/amd64 and linux/arm64, published to GHCR (`ghcr.io/zigzagt`) and DockerHub (`deaddev`). Images are built via `docker buildx` with multi-arch support.

## Build Commands

All builds go through the Makefile. Key variables (all overridable):

```bash
# Build a single image locally (no push)
make ubuntu
make qemu
make shadowsocks

# Build all images
make all

# Build with specific parameters
make ubuntu UPSTREAM_TAGS="24.04" PLATFORM=linux/arm64 PUSH=false

# Build ubuntu variants
make ubuntu-nodejs
make ubuntu-rust
make ubuntu-geoip  # requires MAXMIND_LICENSE_KEY

# Test the timezone validation
make test-ubuntu-setup-tz
```

Key Makefile variables: `UPSTREAM_TAGS` (Ubuntu versions), `LATEST_TAG`, `NODEJS_VERSIONS`, `DEFAULT_NODEJS_VERSION`, `QEMU_VERSIONS`, `CH_VERSIONS`, `REGISTRIES`, `PLATFORM`, `PUSH`, `TAG_SUFFIX`.

Per-arch split builds use `TAG_SUFFIX=-amd64` or `-arm64`, then `merge-*` targets combine them into multi-arch manifests via `docker buildx imagetools create`.

## Image Dependency Tree

```
ubuntu (base)
├── ubuntu:nodejs       (Dockerfile.nodejs)
├── ubuntu:rust         (Dockerfile.rust)
│   └── shadowsocks     (multi-stage: builds on rust, runs on base)
├── ubuntu:bun          (Dockerfile.bun)
├── ubuntu-geoip        (base + MaxMind .mmdb databases)
├── browser:chrome      (nodejs + Chromium + browser-bridge, amd64 only)
├── dnsmasq             (base + dnsmasq)
├── qemu                (base + QEMU compiled from source)
└── cloud-hypervisor    (base + static binaries from GitHub releases)

Independent (no ubuntu base):
├── dnsmasq_exporter    (Go build → scratch)
├── sqitch-pg           (Alpine + Sqitch)
└── wait-for-pg         (Alpine + pg_isready)
```

Changing `ubuntu/` triggers rebuilds of all dependent images (ubuntu-geoip, shadowsocks, dnsmasq, qemu, cloud-hypervisor). This cascade is encoded in the CI change detection logic.

## Ubuntu Base Image Design

The base ubuntu image compiles two C programs (`setup-tz.c`, `setup-apt.c`) as setuid binaries during build. These run at container start via `entrypoint.sh` to configure timezone and APT mirror, then self-delete for security. The `CONTAINER_SETUP_LOG` env var controls log verbosity.

## CI/CD

Single workflow: `.github/workflows/build-and-push.yml`
- Triggers: push to master, PRs, weekly schedule (Saturday 00:00), manual dispatch
- Change detection: `scripts/has-git-diff-at-path.sh` compares against last successful build commit
- Build strategy: per-arch native runners (ubuntu-latest for amd64, ubuntu-24.04-arm for arm64), then merge manifests
- PRs build but don't push; merges to master push to both registries
- READMEs sync to DockerHub descriptions via `scripts/sync-readme.sh`
- Environment: `action-build-and-push` (contains DOCKERHUB_TOKEN, MAXMIND_LICENSE_KEY secrets)

## Version Discovery

QEMU and Cloud Hypervisor have "edge" tags built from latest upstream releases, discovered at build time:
- `scripts/get-latest-qemu-version.sh` — queries GitHub tags API for latest stable QEMU
- `scripts/get-latest-cloud-hypervisor-version.sh` — queries GitHub releases API

MaxMind GeoIP databases use `scripts/get-and-compare-maxmind-versions.sh` to check for updates via HTTP headers before downloading.

## Adding a New Image

1. Create `<image>/Dockerfile` and `<image>/README.md`
2. Add Make targets: `<image>` (build) and `merge-<image>` (manifest merge)
3. Add to `.PHONY` declarations in Makefile
4. Add change detection in CI workflow (`detect-changes` job)
5. Add build/merge jobs in CI workflow, wiring dependencies correctly
6. If it depends on ubuntu base, add it to the ubuntu-change cascade in `detect-changes`

## Adding a New Ubuntu Variant

1. Create `ubuntu/Dockerfile.<variant>` following the pattern of `Dockerfile.nodejs` or `Dockerfile.rust`
2. Add `ubuntu-<variant>` Make target with the same loop/tagging structure
3. Add `merge-ubuntu-<variant>` target
4. Add CI build/merge jobs following the nodejs/rust pattern
