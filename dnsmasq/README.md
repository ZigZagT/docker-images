# dnsmasq

```bash
docker pull deaddev/dnsmasq
```

Lightweight DNS/DHCP server based on `deaddev/ubuntu`.

Includes a custom entrypoint with `WAIT_FOR_START_SIGNAL` support — set the env var to block the container until a `SIGUSR2` signal is received, allowing programmatic configuration before the service starts.
