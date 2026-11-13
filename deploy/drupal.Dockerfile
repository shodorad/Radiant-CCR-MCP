# The CCR (Drupal 10) for the hosted POC. Build context: the repo root.
FROM drupal:10-php8.3-apache-bookworm

# mariadb-client: drush sql:dump for backups.
RUN apt-get update \
 && apt-get install -y --no-install-recommends mariadb-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/drupal
RUN rm -rf /opt/drupal/*
COPY ccr/ /opt/drupal/
RUN composer install --no-dev --no-interaction --no-progress --optimize-autoloader \
 && mkdir -p web/sites/default/files \
 && chown -R www-data:www-data web/sites/default/files

ENV PATH=/opt/drupal/vendor/bin:$PATH
