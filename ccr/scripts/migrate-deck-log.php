<?php

/**
 * Adds the deck-definition fields to the generation log.
 *
 * Run with:  ddev drush php:script scripts/migrate-deck-log.php
 *
 * Unwelding phase 3 made a deck an ordered list of (template, record,
 * selection), and the rows of this table are that list. A row used to be "a
 * person holds a deck of this content"; it is now "this is slide N of that
 * deck". Five base fields carry the difference.
 *
 * Separate from build-content-model.php on purpose, for the same reason
 * migrate-model.php is: a script that creates what is missing should never also
 * be the thing that changes live storage. Idempotent — installing a field
 * definition that is already installed is a no-op, and it says which it did.
 *
 * **No values are carried across, and that is safe here rather than lucky.**
 * Existing rows keep their content, owner and timestamps and simply gain empty
 * deck fields, so they still render on the dashboard as single-slide decks.
 * `demo.sh reset` clears the log anyway, and `seed-content.php` writes a fresh
 * definition, so nothing in the demo depends on a row that predates this.
 */

use Drupal\Core\Field\BaseFieldDefinition;

$manager = \Drupal::entityDefinitionUpdateManager();
$definitions = \Drupal::service('entity_field.manager')
  ->getBaseFieldDefinitions('ccr_deck_generation');

$wanted = ['deck_id', 'deck_label', 'delta', 'template', 'selection'];

$installed = [];
$already = [];
foreach ($wanted as $name) {
  if (!isset($definitions[$name])) {
    throw new \RuntimeException(sprintf(
      'DeckGeneration declares no "%s" field. This script installs storage for fields the class already defines; add it there first.',
      $name
    ));
  }
  if ($manager->getFieldStorageDefinition($name, 'ccr_deck_generation')) {
    $already[] = $name;
    continue;
  }
  $manager->installFieldStorageDefinition($name, 'ccr_deck_generation', 'ccr_poc', $definitions[$name]);
  $installed[] = $name;
}

printf("installed  %s\n", $installed ? implode(', ', $installed) : '(nothing new)');
printf("already    %s\n", $already ? implode(', ', $already) : '(none)');

// Rows that predate this are single-slide decks by definition; give them a
// deck_id so the dashboard can group every row the same way.
$storage = \Drupal::entityTypeManager()->getStorage('ccr_deck_generation');
$adopted = 0;
foreach ($storage->loadMultiple() as $row) {
  if ($row->get('deck_id')->value) {
    continue;
  }
  $row->set('deck_id', 'solo-' . $row->get('content_nid')->value . '-' . preg_replace('/[^a-z0-9]+/', '-', strtolower((string) $row->get('generated_by')->value)));
  $row->set('deck_label', $row->get('content_title')->value);
  $row->set('delta', 0);
  $row->save();
  $adopted++;
}
printf("adopted    %d existing row(s) as single-slide decks\n", $adopted);
