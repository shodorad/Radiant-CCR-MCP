<?php

/**
 * The deck the demo opens with.
 *
 * Run on its own, or included by seed-content.php after the pillars exist:
 *   ddev drush php:script scripts/seed-deck.php
 *
 * Seeded rather than left empty so `demo.sh reset` and `./demo.sh rehearse` put
 * the demo back to a known place. Beat 1 shows a deck *changing*; a marketer
 * starting from an empty builder would be a different, weaker moment.
 *
 * Three slides, three templates, and neither content slide shows all six
 * pillars — which is the whole point of unwelding phase 3.
 *
 *   1. a cover, which has no repeating slot at all
 *   2. slide 4's framework row, which holds five
 *   3. the four-column capability grid, which holds four
 *
 * Slide 3 skips "Product Development and Integration": its 35 characters wrap
 * to three lines in a heading box that holds two, and the renderer says exactly
 * that if you pick it. Chosen by position rather than by name so this stays
 * legible, and because seed-content.php creates the pillars in fixture order.
 *
 * The deck belongs to the account the demo signs in as. Seeding it against a
 * name nobody logs in with would open the builder on an empty form.
 */

use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\user\Entity\User;

$storage = \Drupal::entityTypeManager()->getStorage('node');
$nodes = $storage->loadByProperties(['type' => 'company_overview']);
$node = $nodes ? reset($nodes) : NULL;
if (!$node) {
  throw new \RuntimeException('there is no company overview to build a deck from; run scripts/seed-content.php first');
}

$pillars = $node->get('field_capability_pillars')->referencedEntities();
if (count($pillars) < 6) {
  throw new \RuntimeException(sprintf(
    'the demo deck expects the six pillars the business has; this record holds %d', count($pillars)
  ));
}

$pick = fn(array $positions) => ['items' => array_map(fn($i) => $pillars[$i]->uuid(), $positions)];

$entries = [
  ['template' => 'section-cover',      'node' => $node, 'selection' => []],
  ['template' => 'company-overview',   'node' => $node, 'selection' => $pick([0, 1, 2, 3, 4])],
  ['template' => 'capability-columns', 'node' => $node, 'selection' => $pick([0, 2, 4, 5])],
];

$owner = User::load(1)?->getAccountName() ?: 'admin';
$deck_id = 'deck-' . $node->id() . '-' . preg_replace('/[^a-z0-9]+/', '-', strtolower($owner));
DeckGeneration::saveDeck($deck_id, $node->label(), $owner, $entries);

printf(
  "seeded deck %s for %s: %d slides (%s)\n",
  $deck_id, $owner, count($entries), implode(' + ', array_column($entries, 'template'))
);
