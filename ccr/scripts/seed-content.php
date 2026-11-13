<?php

/**
 * Seeds the Company Overview node from the phase 0 fixture.
 *
 * Run with:  ddev drush php:script scripts/seed-content.php
 *
 * The fixture is the shared source, so the CCR and the renderer start from
 * exactly the same content and any difference in what they produce is a real
 * difference rather than a transcription error.
 */

use Drupal\node\Entity\Node;
use Drupal\paragraphs\Entity\Paragraph;

$fixture_path = '/mnt/repo/fixtures/company-overview.json';
if (!file_exists($fixture_path)) {
  throw new \RuntimeException("fixture not found at {$fixture_path}");
}
$fixture = json_decode(file_get_contents($fixture_path), TRUE, 512, JSON_THROW_ON_ERROR);

// Update in place rather than delete and recreate. The node's UUID is the key
// the website instance matches on, so churning it would orphan the published
// page every time the demo was reset.
$storage = \Drupal::entityTypeManager()->getStorage('node');
$existing = $storage->loadByProperties(['type' => 'company_overview']);
$node = $existing ? reset($existing) : NULL;

if ($node) {
  foreach ($node->get('field_capability_pillars')->referencedEntities() as $old) {
    $old->delete();
  }
}

$pillars = [];
foreach ($fixture['capability_pillars'] as $item) {
  $paragraph = Paragraph::create([
    'type' => 'capability_pillar',
    'field_pillar_name' => $item['name'],
    'field_pillar_description' => ['value' => $item['description'], 'format' => 'ccr_inline'],
    'field_icon_token' => $item['icon_token'],
  ]);
  $paragraph->save();
  $pillars[] = ['target_id' => $paragraph->id(), 'target_revision_id' => $paragraph->getRevisionId()];
}

$node = $node ?: Node::create(['type' => 'company_overview', 'uid' => 1]);
$node->setTitle($fixture['title']);
$node->set('field_positioning_statement', ['value' => $fixture['positioning_statement'], 'format' => 'ccr_inline']);
$node->set('field_framework_name', $fixture['framework_name']);
$node->set('field_framework_statement', ['value' => $fixture['framework_statement'], 'format' => 'ccr_inline']);
$node->set('field_capability_pillars', $pillars);
$node->setPublished();
$node->setNewRevision(TRUE);
$node->setRevisionLogMessage('Seeded from fixtures/company-overview.json.');
$node->save();

printf("%s node %d: %s (%d pillars)\n", $existing ? 'reseeded' : 'created', $node->id(), $node->label(), count($pillars));

// The deck the demo opens with, in its own script so `demo.sh reset` and the
// rehearsal can put it back without reseeding the content underneath it.
require __DIR__ . '/seed-deck.php';

printf("edit at  http://ccr-mcp.ddev.site/node/%d/edit\n", $node->id());
printf("deck at  http://ccr-mcp.ddev.site/node/%d/deck\n", $node->id());
