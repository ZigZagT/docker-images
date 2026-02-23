# cloud-hypervisor

> **Source**: [Dockerfile](https://github.com/ZigZagT/docker-images/blob/master/cloud-hypervisor/Dockerfile)

```bash
docker pull deaddev/cloud-hypervisor
# or
docker pull ghcr.io/zigzagt/cloud-hypervisor
```

[Cloud Hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor) with pre-built static binaries and firmware.

## Tags

- `deaddev/cloud-hypervisor:<version>` — pinned version (e.g., `51.1`)
- `deaddev/cloud-hypervisor:latest` — latest pinned version
- `deaddev/cloud-hypervisor:edge` — latest stable version auto-discovered from upstream

## Binaries

- `/usr/bin/cloud-hypervisor` — VMM (static binary)
- `/usr/bin/ch-remote` — remote control CLI (static binary)

## Firmware

- `/usr/share/cloud-hypervisor/CLOUDHV.fd` — UEFI firmware (from cloud-hypervisor/edk2)
- `/usr/share/cloud-hypervisor/hypervisor-fw` — direct boot firmware (from cloud-hypervisor/rust-hypervisor-firmware)
