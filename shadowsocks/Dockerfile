# Build shadowsocks-rust from source with selective features
FROM deaddev/ubuntu:rust AS builder

WORKDIR /build
RUN echo "Installing build dependencies..." \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        clang \
        cmake \
        libssl-dev \
        pkg-config \
    && echo "Building shadowsocks-rust..." \
    # --no-default-features: default = "full" which pulls in manager/utility/service
    # server: ssserver binary
    # local-redir: Transparent proxy support (redirect/tproxy)
    # local-tunnel: Port forwarding support
    # local-dns: Built-in DNS server (forward dns queries to upstream, add doh/dot support)
    # local-tun: TUN interface support
    # hickory-dns: Async Rust DNS resolver (performance)
    # dns-over-tls/https: Support for DoT/DoH upstreams
    # aead-cipher-2022: AEAD 2022 ciphers (current recommended ciphers)
    # stream-cipher: Legacy stream ciphers (backward compat)
    # jemalloc: Memory allocator optimized for long-running servers
    && cargo install shadowsocks-rust \
        --no-default-features \
        --features "server local-redir local-tunnel local-dns local-tun hickory-dns dns-over-tls dns-over-https aead-cipher-2022 stream-cipher jemalloc"

FROM deaddev/ubuntu

WORKDIR /config

COPY --from=builder /root/.cargo/bin/sslocal /usr/bin/
COPY --from=builder /root/.cargo/bin/ssserver /usr/bin/

RUN apt-get update \
    && apt-get install -y \
        libcap2-bin \
    && setcap cap_net_bind_service,cap_net_raw+ep /usr/bin/sslocal \
    && setcap cap_net_bind_service,cap_net_raw+ep /usr/bin/ssserver \
    && apt-get autoremove -y --purge \
    && rm -rf /var/lib/apt/lists/*

USER nobody
