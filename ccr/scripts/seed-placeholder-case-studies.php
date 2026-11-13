<?php

/**
 * Seeds the placeholder case studies from fixtures/placeholder-case-studies/.
 *
 * Run with:  ddev drush php:script scripts/seed-placeholder-case-studies.php
 *
 * Decision 3 of the POC plan asks for two or three case studies beyond
 * Kestrelmoor so the MCP has something to choose between. Real ones are not
 * available yet, so these are fictional and say so in their title and first
 * line. Each carries a NOT FOR PUBLICATION section on purpose: it is what proves
 * the public view (/ccr/record?view=public) withholds it.
 *
 * Updated in place by uuid. Delete them, or unpublish them, when the real case
 * studies are loaded.
 */

use Drupal\node\Entity\Node;

$dir = '/mnt/repo/fixtures/placeholder-case-studies';
$files = glob("{$dir}/*.json") ?: [];
if (!$files) {
  throw new \RuntimeException("no placeholder case studies found in {$dir}");
}

$storage = \Drupal::entityTypeManager()->getStorage('node');
foreach ($files as $file) {
  $fixture = json_decode(file_get_contents($file), TRUE, 512, JSON_THROW_ON_ERROR);
  $existing = $storage->loadByProperties(['type' => 'case_study', 'uuid' => $fixture['id']]);
  $node = $existing ? reset($existing) : Node::create(['type' => 'case_study', 'uuid' => $fixture['id'], 'uid' => 1]);
  $action = $node->isNew() ? 'created' : 'updated';

  $node->setTitle($fixture['title']);
  $node->set('field_client_name', $fixture['client_name']);
  $node->set('field_source_material', $fixture['source_material']);
  $node->setPublished();
  $node->save();

  echo "placeholder case study {$action}: node/{$node->id()}  " . basename($file) . "\n";
}
