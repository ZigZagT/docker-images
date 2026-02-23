# shadowsocks

```bash
docker pull deaddev/shadowsocks
```

[shadowsocks-rust](https://github.com/shadowsocks/shadowsocks-rust) built from source with explicit feature selection.

## Binaries

- `sslocal` - Client proxy (SOCKS5, HTTP, transparent redirect, tunnel, DNS, TUN)
- `ssserver` - Server proxy

## Build features

Built with `--no-default-features` to avoid the `full` meta-feature. Enabled features:

- `server`, `local-redir`, `local-tunnel`, `local-dns`, `local-tun` - Protocol support
- `hickory-dns`, `dns-over-tls`, `dns-over-https` - DNS resolution
- `aead-cipher-2022`, `stream-cipher` - Cipher suites
- `jemalloc` - Memory allocator for long-running servers

All dependencies (crypto, DNS, event loop) are statically linked by Rust. No runtime library packages needed.
