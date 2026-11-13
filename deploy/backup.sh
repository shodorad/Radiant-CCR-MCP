#!/usr/bin/env bash
# Nightly database dump, kept 14 days. Cron on the VM:
#   15 2 * * * /opt/radiant-ccr/deploy/backup.sh >> /var/log/ccr-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
docker compose exec -T drupal drush sql:dump --gzip --result-file=/tmp/ccr.sql >/dev/null
docker compose cp drupal:/tmp/ccr.sql.gz "backups/ccr-$(date +%F).sql.gz"
find backups -name 'ccr-*.sql.gz' -mtime +14 -delete
echo "$(date -Is) backup ok"
