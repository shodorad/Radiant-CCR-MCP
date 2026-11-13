<?php

/**
 * Forward migration onto the phase 2 content model — the one that has stopped
 * describing a slide.
 *
 * Run with:  ddev drush php:script scripts/migrate-model.php
 *            ddev drush php:script scripts/build-content-model.php
 *            ddev drush php:script scripts/configure-displays.php
 *
 * `build-content-model.php` creates what is missing; it does not change what is
 * already there, because a script that silently rewrites live field storage is
 * not a script anyone should run twice. So the changes that alter an existing
 * field live here, separately, and each one says what it is doing.
 *
 * Three changes, all of them removing a property of slide 4 from the
 * repository (docs/content-model.md §2.3, plan.md §7):
 *
 *   1. `field_capability_pillars` was capped at five because the slide's icon
 *      row is five icons joined by four fixed arrows. The website has six. The
 *      cap is a fact about one piece of artwork and it does not belong here;
 *      the *template* refuses a sixth at generation time, with a message that
 *      names the template rather than blaming the content.
 *
 *   2. `field_pillar_name` was 36 characters because that is what its box holds
 *      at 12.89 pt. Storage capped at 36 means a marketer physically cannot
 *      type a longer name — the limit stopped being advice and became a wall.
 *      Widened to 255; the 36 survives as a live counter, which is a hint.
 *
 *   3. `field_framework_label` is named after where it lands on the slide — the
 *      label on the green band. What it *is* is the framework's name. Renamed
 *      to `field_framework_name`.
 *
 * Idempotent: every step checks whether it has already happened.
 *
 * **Stated limitation, and it is sharper than it first looks.** Steps 2 and 3
 * recreate a field, which is the supported way to widen a string or rename one,
 * and field data is purged with the old field — so values are copied from the
 * *default* revision only. Older revisions do not merely lose the value in a
 * historical-record sense: `node_revision__field_framework_name` has no row for
 * them at all, so **reverting to a pre-migration revision produces a node with
 * no framework name**. The renderer refuses such a record rather than shipping a
 * blank green pill (`renderer/lib/source.js`), which is the safety net, not the
 * fix. Acceptable here because the CCR holds one seeded node and
 * `scripts/seed-content.php` rebuilds it; production would run a field
 * migration that carries every revision. Recorded in plan.md §4.
 *
 * **On ordering.** Both steps read the values first, put them somewhere durable,
 * and only then touch the field. Step 2 originally dropped the field while its
 * values existed solely in a PHP array — a fatal, a purge race or a ^C between
 * the drop and the restore would have lost every pillar name with no recovery.
 * The values now go into Drupal's state store before anything is deleted, and a
 * re-run picks them back up, so an interrupted migration is resumable rather
 * than terminal.
 */

use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;

$etm = \Drupal::entityTypeManager();
$changed = 0;

/**
 * Every value of one field, keyed by entity id. Default revision only.
 */
function ccr_read_values(string $entity_type, string $bundle_key, string $bundle, string $field): array {
  if (!FieldStorageConfig::loadByName($entity_type, $field)) {
    return [];
  }
  $storage = \Drupal::entityTypeManager()->getStorage($entity_type);
  $ids = $storage->getQuery()
    ->accessCheck(FALSE)
    ->condition($bundle_key, $bundle)
    ->execute();

  $values = [];
  foreach ($storage->loadMultiple($ids) as $id => $entity) {
    if ($entity->hasField($field) && !$entity->get($field)->isEmpty()) {
      $values[$id] = $entity->get($field)->value;
    }
  }
  return $values;
}

/**
 * Write values back, without spawning a revision per entity.
 *
 * The cache clear is not optional. A field created earlier in this same script
 * run is not yet in the cached field definitions, so `hasField()` says no, every
 * entity is skipped, and the migration reports "restored 0 values" while
 * cheerfully deleting the old field afterwards. Found the hard way.
 */
function ccr_write_values(string $entity_type, string $field, array $values): int {
  \Drupal::service('entity_field.manager')->clearCachedFieldDefinitions();
  \Drupal::entityTypeManager()->clearCachedDefinitions();
  $storage = \Drupal::entityTypeManager()->getStorage($entity_type);
  $storage->resetCache();
  $written = 0;
  foreach ($values as $id => $value) {
    $entity = $storage->load($id);
    if (!$entity || !$entity->hasField($field)) {
      continue;
    }
    $entity->set($field, $value);
    if (method_exists($entity, 'setNewRevision')) {
      $entity->setNewRevision(FALSE);
    }
    $entity->save();
    $written++;
  }
  return $written;
}

/**
 * Stash values somewhere that survives this PHP process.
 *
 * Widening a string means dropping the field, and a drop is the point of no
 * return: from there until the values are written back they exist only in
 * memory. Putting them in state first makes that window survivable.
 */
function ccr_stash(string $key, array $values): void {
  \Drupal::state()->set("ccr_poc.migrate.{$key}", $values);
}

function ccr_unstash(string $key, array $fallback): array {
  return \Drupal::state()->get("ccr_poc.migrate.{$key}", $fallback);
}

function ccr_unstash_clear(string $key): void {
  \Drupal::state()->delete("ccr_poc.migrate.{$key}");
}

/**
 * Remove a field and purge it, so a field of the same name can be created.
 *
 * Drupal marks a deleted field for batched purging rather than dropping it, and
 * refuses to create a field whose name is still awaiting purge. Purging here is
 * what makes "delete then recreate" work inside one script run.
 */
function ccr_drop_field(string $entity_type, string $bundle, string $field): void {
  if ($instance = FieldConfig::loadByName($entity_type, $bundle, $field)) {
    $instance->delete();
  }
  if ($storage = FieldStorageConfig::loadByName($entity_type, $field)) {
    $storage->delete();
  }
  field_purge_batch(1000);
}

// ---------------------------------------------------------------------------
// 1. The five-pillar cap.
// ---------------------------------------------------------------------------
$pillars = FieldStorageConfig::loadByName('node', 'field_capability_pillars');
if ($pillars && $pillars->getCardinality() !== FieldStorageConfig::CARDINALITY_UNLIMITED) {
  $pillars->setCardinality(FieldStorageConfig::CARDINALITY_UNLIMITED);
  $pillars->save();
  echo "field_capability_pillars: cardinality 5 -> unlimited\n";
  echo "  the five-slot template still refuses a sixth, by name, at generation time\n";
  $changed++;
}

// ---------------------------------------------------------------------------
// 2. The pillar name's 36-character wall.
// ---------------------------------------------------------------------------
$name = FieldStorageConfig::loadByName('paragraph', 'field_pillar_name');
if ($name && (int) $name->getSetting('max_length') !== 255) {
  // Read, then stash, then drop. A previous interrupted run left its values in
  // state; they are preferred over what is readable now, which may be nothing.
  $keep = ccr_unstash('field_pillar_name', ccr_read_values('paragraph', 'type', 'capability_pillar', 'field_pillar_name'));
  ccr_stash('field_pillar_name', $keep);
  echo "field_pillar_name: widening 36 -> 255, carrying " . count($keep) . " values\n";

  $label = FieldConfig::loadByName('paragraph', 'capability_pillar', 'field_pillar_name')->label();
  ccr_drop_field('paragraph', 'capability_pillar', 'field_pillar_name');

  FieldStorageConfig::create([
    'field_name' => 'field_pillar_name',
    'entity_type' => 'paragraph',
    'type' => 'string',
    'cardinality' => 1,
    'settings' => ['max_length' => 255],
  ])->save();
  FieldConfig::create([
    'field_name' => 'field_pillar_name',
    'entity_type' => 'paragraph',
    'bundle' => 'capability_pillar',
    'label' => $label,
    'required' => TRUE,
    'description' => 'The pillar, named. The deck template you generate into decides how much of it fits.',
  ])->save();

  $restored = ccr_write_values('paragraph', 'field_pillar_name', $keep);
  echo "  restored {$restored} values\n";
  if ($restored !== count($keep)) {
    throw new \RuntimeException(sprintf(
      'field_pillar_name: carried %d of %d values. The originals are in state under ' .
      '"ccr_poc.migrate.field_pillar_name" — re-run this script to try again.',
      $restored, count($keep)
    ));
  }
  ccr_unstash_clear('field_pillar_name');
  $changed++;
}

// ---------------------------------------------------------------------------
// 3. field_framework_label -> field_framework_name.
// ---------------------------------------------------------------------------
if (!FieldStorageConfig::loadByName('node', 'field_framework_name')) {
  $keep = ccr_unstash('field_framework_label', ccr_read_values('node', 'type', 'company_overview', 'field_framework_label'));
  ccr_stash('field_framework_label', $keep);
  echo "field_framework_label -> field_framework_name, carrying " . count($keep) . " values\n";

  FieldStorageConfig::create([
    'field_name' => 'field_framework_name',
    'entity_type' => 'node',
    'type' => 'string',
    'cardinality' => 1,
    'settings' => ['max_length' => 255],
  ])->save();
  FieldConfig::create([
    'field_name' => 'field_framework_name',
    'entity_type' => 'node',
    'bundle' => 'company_overview',
    'label' => 'Framework name',
    'required' => TRUE,
    'description' => 'The name of the approach. Named for what it is, not for the green band it lands on.',
  ])->save();

  $restored = ccr_write_values('node', 'field_framework_name', $keep);
  echo "  restored {$restored} values\n";
  if ($restored !== count($keep)) {
    throw new \RuntimeException(sprintf(
      'refusing to remove field_framework_label: carried %d of %d values. Nothing has been deleted.',
      $restored, count($keep)
    ));
  }
  ccr_drop_field('node', 'company_overview', 'field_framework_label');
  ccr_unstash_clear('field_framework_label');
  echo "  removed field_framework_label\n";
  $changed++;
}

echo $changed ? "\n{$changed} change" . ($changed === 1 ? '' : 's') . " applied\n"
              : "\nnothing to migrate — the model is already the phase 2 one\n";
