# Wait For PG

Wait for PostgreSQL DB ready to execute a SQL by running `select version()` every 2 seconds.

Specify these environment variables to target the pg database for waiting:

- `DB_HOST`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`

```
docker pull deaddev/wait-for-pg
```

This image can be used as `initContainers` in Kubernetes Pods. Useful for CI deployments.
