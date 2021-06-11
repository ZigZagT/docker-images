# Sqitch PG

Alpine based [Sqitch](https://sqitch.org/) build with PostgreSQL connector.

```bash
docker pull deaddev/sqitch-pg
```

Optionally add the shell function for quick and easy CLI access:

```bash
sqitch() {
    local SOURCE_PATH="${1:-.}"; shift
    docker run --rm -it -v "$(realpath "$SOURCE_PATH")":/sqitch -v /tmp/.s.PGSQL.5432:/tmp/.s.PGSQL.5432:ro deaddev/sqitch-pg "$@"
}
```

Assume you have sqitch configuration files located at `~/my-sqitch`,

running `sqitch ~/my-sqitch <options> deploy` with the shell function is equivalent to run `cd ~/my-sqitch; sqitch <options> deploy`.

### Image Size:

compressed: 18MB
uncompressed: 79MB
