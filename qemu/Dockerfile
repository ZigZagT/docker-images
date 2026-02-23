ARG BASE_IMAGE=deaddev/ubuntu
FROM ${BASE_IMAGE}

ARG QEMU_VERSION
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

# see https://download.qemu.org/
# https://wiki.qemu.org/ChangeLog/

RUN if [ -z "$QEMU_VERSION" ]; then echo "QEMU_VERSION not set" && exit 1; fi \
    && BUILD_DEPS=" \
        build-essential \
        ninja-build \
        python3-venv \
        xz-utils \
        libusb-1.0-0-dev \
        libglib2.0-dev libfdt-dev libpixman-1-dev zlib1g-dev \
        libaio-dev libbluetooth-dev libcapstone-dev libbrlapi-dev libbz2-dev \
        libcap-ng-dev libcurl4-gnutls-dev libgtk-3-dev \
        libibverbs-dev libjpeg8-dev libncurses5-dev libnuma-dev \
        librbd-dev librdmacm-dev \
        libsasl2-dev libsdl2-dev libseccomp-dev libsnappy-dev libssh-dev \
        libvde-dev libvdeplug-dev libvte-2.91-dev libxen-dev liblzo2-dev \
        valgrind xfslibs-dev \
        liburing-dev libjemalloc-dev \
    " \
    && apt-get update \
    && apt-get install -y \
        kmod \
        usbutils \
        pciutils \
        numactl \
        libxml2 \
        swtpm \
        netcat-openbsd \
        ovmf \
        python3-pip \
        $BUILD_DEPS \
    && wget --timeout=30 --progress=dot:giga "https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz" \
    && tar xJf "qemu-${QEMU_VERSION}.tar.xz" \
    && cd "qemu-${QEMU_VERSION}" \
    && ./configure \
        --enable-system \
        --disable-user \
        --enable-kvm \
        --enable-libusb \
        --enable-vnc \
        --enable-linux-io-uring \
        --enable-linux-aio \
        --enable-vhost-kernel \
        --enable-vhost-net \
        --enable-tpm \
        --enable-malloc=jemalloc \
        --enable-trace-backends=simple \
        --target-list='x86_64-softmmu' \
    && make -j"$(nproc)" \
    && make install \
    && cd / \
    && rm -rf "qemu-${QEMU_VERSION}" "qemu-${QEMU_VERSION}.tar.xz" \
    && apt-get purge --autoremove -y $BUILD_DEPS \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir qemu.qmp

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /vm
