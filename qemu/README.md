# qemu

```bash
docker pull deaddev/qemu
```

QEMU built from source, optimized for KVM Windows guest with VFIO/PCI passthrough.

## Tags

- `deaddev/qemu:<version>` — pinned QEMU version (e.g., `10.2.1`)
- `deaddev/qemu:latest` — latest pinned version
- `deaddev/qemu:edge` — latest stable version auto-discovered from upstream

## Configure flags

```
--enable-system --disable-user --enable-kvm --enable-libusb --enable-vnc
--enable-linux-io-uring --enable-linux-aio --enable-vhost-kernel --enable-vhost-net
--enable-tpm --enable-malloc=jemalloc --enable-trace-backends=simple
--target-list=x86_64-softmmu
```

## Included

- OVMF UEFI firmware
- swtpm (TPM emulation)
- kmod, usbutils, pciutils, numactl (VFIO/passthrough utilities)
- Python venv at `/opt/venv` with `qemu.qmp` (QMP client library)
