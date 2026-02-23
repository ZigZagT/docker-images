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
        kmod usbutils pciutils numactl libxml2 \
        swtpm netcat-openbsd ovmf \
        python3-pip python3-venv \
        libglib2.0-0t64 libfdt1 libpixman-1-0 libaio1t64 \
        libcapstone4 libbrlapi0.8 libcurl3t64-gnutls libgtk-3-0t64 \
        libibverbs1 libjpeg-turbo8 librbd1 librdmacm1t64 \
        libsdl2-2.0-0 libsndio7.0 libsnappy1v5 libvde0 libvdeplug2t64 \
        libvte-2.91-0 liblzo2-2 liburing2 libjemalloc2 \
        libxentoollog1t64 libxentoolcore1t64 libxencall1t64 \
        libxendevicemodel1t64 libxenevtchn1t64 libxenforeignmemory1t64 \
        libxengnttab1t64 libxenhypfs1t64 libxenstore4t64 libxenmisc4.17t64 \
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

# verify all QEMU binaries can load their shared libraries
RUN for bin in /usr/local/bin/qemu-*; do \
        missing=$(ldd "$bin" | grep 'not found' || true); \
        if [ -n "$missing" ]; then \
            echo "MISSING libs in $(basename $bin):"; echo "$missing"; exit 1; \
        fi; \
    done

RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir qemu.qmp

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /vm
