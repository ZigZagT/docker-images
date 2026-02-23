ARG BASE_IMAGE=deaddev/ubuntu
FROM ${BASE_IMAGE}

ARG CH_VERSION

RUN if [ -z "$CH_VERSION" ]; then echo "CH_VERSION not set" && exit 1; fi \
    && mkdir -p /usr/share/cloud-hypervisor \
    && wget --timeout=30 -O /usr/bin/cloud-hypervisor \
        "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v${CH_VERSION}/cloud-hypervisor-static" \
    && wget --timeout=30 -O /usr/bin/ch-remote \
        "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v${CH_VERSION}/ch-remote-static" \
    && chmod +x /usr/bin/cloud-hypervisor /usr/bin/ch-remote \
    # firmware: UEFI (CLOUDHV.fd) and direct boot (hypervisor-fw)
    # these are from separate repos with independent release cycles,
    # fetched via GitHub releases/latest API at build time
    && CLOUDHV_TAG=$(wget -qO- https://api.github.com/repos/cloud-hypervisor/edk2/releases/latest | jq -r '.tag_name') \
    && wget --timeout=30 -O /usr/share/cloud-hypervisor/CLOUDHV.fd \
        "https://github.com/cloud-hypervisor/edk2/releases/download/${CLOUDHV_TAG}/CLOUDHV.fd" \
    && HYPFW_TAG=$(wget -qO- https://api.github.com/repos/cloud-hypervisor/rust-hypervisor-firmware/releases/latest | jq -r '.tag_name') \
    && wget --timeout=30 -O /usr/share/cloud-hypervisor/hypervisor-fw \
        "https://github.com/cloud-hypervisor/rust-hypervisor-firmware/releases/download/${HYPFW_TAG}/hypervisor-fw" \
    && cloud-hypervisor --version

WORKDIR /vm
