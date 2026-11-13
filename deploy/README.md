# Hosting the POC

One VM runs Docker Compose with five containers.
- **caddy:** TLS, and it blocks the CCR's internal endpoints on the public host.
- **drupal:** the CCR.
- **db:** MariaDB 10.11.
- **renderer:** used in phase 2.
- **mcp:** the MCP server.

```
internet ─▶ caddy ─▶ ccr.<domain>  ─▶ drupal  (editors log in; /ccr/*, /jsonapi → 403)
                  └▶ mcp.<domain>  ─▶ mcp ──▶ http://drupal/ccr/records, /ccr/record?view=public
```

## First deploy

1. Create a ~4 GB Ubuntu 24.04 VM (see `COST.md`). Install Docker Engine and the compose plugin. Open ports 80 and 443 only, plus SSH.
2. Point two DNS names at it, for example `ccr-poc.radiant.digital` and `mcp-poc.radiant.digital`.
3. Get the code onto the VM:
   ```bash
   git clone <repo> /opt/radiant-ccr && cd /opt/radiant-ccr/deploy
   cp .env.example .env && $EDITOR .env      # hosts, DB password, hash salt, MCP_KEYS
   docker compose up -d --build
   ./bootstrap.sh                            # install from config/sync, seed, lock down anonymous access
   ```
4. Check it from your laptop:
   ```bash
   curl -s https://mcp.<domain>/health                                      # 200
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.<domain>/mcp # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://ccr.<domain>/ccr/records # 403
   ```
5. Add the nightly backup cron line from `backup.sh`.

## Day to day

| Task | Command |
|---|---|
| Deploy a change | `git pull && docker compose up -d --build` |
| Add or revoke a tester | Edit `MCP_KEYS` in `.env`, then `docker compose up -d mcp` |
| See who used it | `docker compose logs mcp \| grep tool_call` |
| Drupal admin link | `docker compose exec drupal drush user:login --uri=https://ccr.<domain>` |
