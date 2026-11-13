<?php

/**
 * @file
 * The hosted POC (deploy/docker-compose.yml). Included by settings.php when
 * CCR_ENV=prod. Every secret comes from the environment; none is in the repo.
 */

$databases['default']['default'] = [
  'driver' => 'mysql',
  'host' => getenv('DB_HOST') ?: 'db',
  'port' => 3306,
  'database' => getenv('DB_NAME'),
  'username' => getenv('DB_USER'),
  'password' => getenv('DB_PASSWORD'),
  'prefix' => '',
  'collation' => 'utf8mb4_general_ci',
];

$settings['hash_salt'] = getenv('DRUPAL_HASH_SALT');
$settings['config_sync_directory'] = '../config/sync';

$settings['trusted_host_patterns'] = array_map(
  static fn (string $host): string => '^' . preg_quote(trim($host)) . '$',
  array_filter(explode(',', (string) getenv('DRUPAL_TRUSTED_HOSTS')))
);

// Caddy terminates TLS in front of Apache on the Docker network.
$settings['reverse_proxy'] = TRUE;
$settings['reverse_proxy_addresses'] = [$_SERVER['REMOTE_ADDR'] ?? '127.0.0.1'];

$config['ccr_poc.settings']['renderer_url'] = getenv('RENDERER_URL') ?: 'http://renderer:5001';
$config['system.logging']['error_level'] = 'hide';
