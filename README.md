# Radiant CCR MCP

Radiant's Central Content Repository (CCR), served through an MCP server so anyone with Claude or another MCP-capable chat app can see what content exists and use it.

- **Phase 1 (to Fri 4 Dec 2026):** the MCP lists content and returns it. ← current
- **Phase 2 (to Wed 30 Dec 2026):** the MCP returns an on-brand PowerPoint.

The CCR and the deck renderer were carried over from the `Rad-Content-Model` prototype. Its `CLAUDE.md`, `plan.md` and `docs/` explain why they work the way they do.

## Layout

| Folder | What |
|---|---|
| `ccr/` | Drupal 10 CCR. Custom module `ccr_poc`. Rebuilt from `scripts/` + `config/sync/` |
| `mcp/` | The MCP server (TypeScript). Tools: `list_content`, `get_content` |
| `renderer/` | Template-fill `.pptx` renderer (phase 2's builder) |
| `fixtures/` | Seed content. `placeholder-case-studies/` are **fictional** stand-ins |
| `deploy/` | Docker Compose for one VM: Caddy, Drupal, MariaDB, renderer, MCP |
| `docs/` | `connect.md` (for testers), carried-over design notes |

## Run locally

Needs Docker + DDEV and Node 20+.

```bash
cd ccr && ddev start && ddev composer install
# first time only: install standard, then import the committed config
# (`--existing-config` is refused: the standard profile has a hook_install)
ddev drush site:install standard --account-name=admin --yes
ddev drush config:set system.site uuid "$(grep '^uuid:' config/sync/system.site.yml | cut -d' ' -f2)" --yes
ddev drush entity:delete shortcut --yes
ddev drush config:import --yes
ddev drush php:script scripts/build-content-model.php
ddev drush php:script scripts/seed-content.php
ddev drush php:script scripts/seed-case-study.php
ddev drush php:script scripts/seed-placeholder-case-studies.php
curl -s http://ccr-mcp.ddev.site/ccr/records | jq      # what the MCP will list

cd ../renderer && npm ci && npm start                  # :5001, needed by configure-displays.php
cd ../ccr && ddev drush php:script scripts/configure-displays.php

cd ../mcp && npm ci
npm test                                              # no Drupal needed: fake CCR from fixtures
MCP_KEYS="me:$(openssl rand -hex 24)" npm run dev     # http://localhost:3000/mcp/<key>
npx @modelcontextprotocol/inspector                   # point it at that URL
```

Use it from Claude Code without HTTP:

```bash
claude mcp add ccr-local -e CCR_INTERNAL_URL=http://ccr-mcp.ddev.site -- npx tsx "$PWD/mcp/src/stdio.ts"
```

## CCR endpoints the MCP reads

| Endpoint | Returns |
|---|---|
| `GET /ccr/records[?type=company_overview\|case_study]` | One line per published record: `nid`, `type`, `title`, `changed`, `summary`, `fictional` |
| `GET /ccr/record?nid=N&view=public` | The full neutral record, with **NOT FOR PUBLICATION** sections removed and named in `withheld` |
| `GET /ccr/record[?nid=N]` | The full record, unredacted. Used by the renderer; never exposed publicly |

The redaction lives in `RecordNormaliser::withoutUnpublishable()`: the repository owns its export. The MCP also refuses any record that still carries the marker.

## Hosting

See [deploy/README.md](deploy/README.md).
