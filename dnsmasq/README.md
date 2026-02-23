# dnsmasq

> **Source**: [Dockerfile](https://github.com/ZigZagT/docker-images/blob/master/dnsmasq/Dockerfile)

```bash
docker pull deaddev/dnsmasq
# or
docker pull ghcr.io/zigzagt/dnsmasq
```

Lightweight DNS/DHCP server based on `deaddev/ubuntu`.

Includes a custom entrypoint with `WAIT_FOR_START_SIGNAL` support — set the env var to block the container until a `SIGUSR2` signal is received, allowing programmatic configuration before the service starts.
