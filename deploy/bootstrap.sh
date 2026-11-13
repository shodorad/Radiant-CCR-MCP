#!/usr/bin/env bash
# First-time install of the hosted CCR, from the committed config and fixtures.
# Run once on the VM after `docker compose up -d --build`. Re-running the seed
# half is safe (every script updates in place); the install half refuses if a
# site already exists.
set -euo pipefail
cd "$(dirname "$0")"
dc() { docker compose exec -T "$@"; }
drush() { dc drupal drush "$@"; }

if drush status --field=bootstrap 2>/dev/null | grep -q Successful; then
  echo "Drupal is already installed; skipping site:install."
else
  # `standard` has a hook_install, so Drupal 10 refuses --existing-config for
  # it. Install standard, adopt the export's site uuid, clear the shortcuts
  # standard creates, then import (verified under DDEV, 13 Nov 2026).
  drush site:install standard --account-name=admin --yes
  uuid=$(dc drupal sh -c "grep '^uuid:' config/sync/system.site.yml | cut -d' ' -f2")
  drush config:set system.site uuid "$uuid" --yes
  drush entity:delete shortcut --yes || true
  drush config:import --yes
fi

drush php:script scripts/build-content-model.php
drush php:script scripts/configure-displays.php
drush php:script scripts/seed-content.php
drush php:script scripts/seed-case-study.php
drush php:script scripts/seed-placeholder-case-studies.php

# A public host: nobody reads content without logging in. The MCP and renderer
# read /ccr/record over the Docker network, which does not need this.
drush role:perm:remove anonymous 'access content'
drush cache:rebuild

echo
echo "Admin login link (one-time):"
drush user:login --uri="https://$(grep ^CCR_HOST= .env | cut -d= -f2)"
