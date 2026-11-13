<?php

/**
 * Seeds the case study from fixtures/case-study.json.
 *
 * Run with:  ddev drush php:script scripts/seed-case-study.php
 *
 * The case study is fictional and says so in its first line — written for the
 * proof of concept, as raw source material of the kind a delivery team would
 * actually have: notes, measured results with where they came from, one
 * projection that is not a result, an interview, and a section marked not for
 * publication. It is deliberately not tidy, because tidying it is the job the
 * writer is being tested on.
 *
 * Updated in place by uuid, so approved copy and published pages stay attached
 * to the same record across a reseed.
 */

use Drupal\node\Entity\Node;

$fixture_path = '/mnt/repo/fixtures/case-study.json';
if (!file_exists($fixture_path)) {
  throw new \RuntimeException("fixture not found at {$fixture_path}");
}
$fixture = json_decode(file_get_contents($fixture_path), TRUE, 512, JSON_THROW_ON_ERROR);

$storage = \Drupal::entityTypeManager()->getStorage('node');
$existing = $storage->loadByProperties(['type' => 'case_study', 'uuid' => $fixture['id']]);
$node = $existing ? reset($existing) : Node::create(['type' => 'case_study', 'uuid' => $fixture['id'], 'uid' => 1]);
$action = $node->isNew() ? 'created' : 'updated';

$node->setTitle($fixture['title']);
$node->set('field_client_name', $fixture['client_name']);
$node->set('field_source_material', $fixture['source_material']);
$node->setPublished();
$node->save();

echo "case study {$action}: node/{$node->id()}\n";
