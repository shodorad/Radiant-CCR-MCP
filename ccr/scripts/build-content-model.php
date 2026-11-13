<?php

/**
 * Builds the Company Overview content model in the CCR.
 *
 * Run with:  ddev drush php:script scripts/build-content-model.php
 *
 * Written as a script rather than click-work in the admin UI so the model is
 * reproducible and reviewable — the maintaining developer can read this file
 * and know exactly what exists. Config is exported to config/sync afterwards;
 * this script is how that config was authored, not a second source of truth.
 *
 * Every field here traces to docs/content-model.md. Nothing is invented: the
 * fields come from slide 4 of the Radiant Capabilities Overview deck.
 *
 * The *limits* no longer do. Until unwelding phase 2 this file also carried
 * slide 4's boxes — a pillar name could not exceed 36 characters and there
 * could not be a sixth pillar, because that is what one piece of artwork holds.
 * A repository that refuses to store what the business has is not a repository.
 * The limits now live in the deck template's blueprint card, which refuses at
 * generation time and names itself while doing it; what survives here is a live
 * counter on the form, which is a hint rather than a wall. See plan.md §7.
 *
 * This script creates what is missing. It does not change what is already
 * there — `scripts/migrate-model.php` does that, separately and loudly.
 */

use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\node\Entity\NodeType;
use Drupal\paragraphs\Entity\ParagraphsType;

$entity_type_manager = \Drupal::entityTypeManager();
$display_repository = \Drupal::service('entity_display.repository');

// ---------------------------------------------------------------------------
// 1. The text format.
//
// Emphasis is the only formatting the model carries, so it is the only
// formatting the editor can apply. One button. A marketer cannot put an
// off-brand colour, a heading or a pasted font on a slide because there is no
// way to express one.
// ---------------------------------------------------------------------------
$format = $entity_type_manager->getStorage('filter_format')->load('ccr_inline');
if (!$format) {
  $format = $entity_type_manager->getStorage('filter_format')->create([
    'format' => 'ccr_inline',
    'name' => 'CCR inline emphasis',
    'weight' => -10,
    'filters' => [
      'filter_html' => [
        'status' => TRUE,
        'weight' => -10,
        'settings' => [
          'allowed_html' => '<strong>',
          'filter_html_help' => FALSE,
          'filter_html_nofollow' => FALSE,
        ],
      ],
    ],
  ]);
  $format->save();
  echo "created text format ccr_inline\n";
}

$editor = $entity_type_manager->getStorage('editor')->load('ccr_inline');
if (!$editor) {
  $entity_type_manager->getStorage('editor')->create([
    'format' => 'ccr_inline',
    'editor' => 'ckeditor5',
    'settings' => [
      'toolbar' => ['items' => ['bold', '|', 'undo', 'redo']],
      'plugins' => [],
    ],
    'image_upload' => ['status' => FALSE],
  ])->save();
  echo "created CKEditor 5 profile for ccr_inline (bold only)\n";
}

// ---------------------------------------------------------------------------
// 2. The capability pillar paragraph.
// ---------------------------------------------------------------------------
if (!ParagraphsType::load('capability_pillar')) {
  ParagraphsType::create([
    'id' => 'capability_pillar',
    'label' => 'Capability pillar',
    'description' => 'One column of the pillar row: a name, a one-line description and a brand icon.',
  ])->save();
  echo "created paragraph type capability_pillar\n";
}

/**
 * Create a field storage and instance if they are not already there.
 */
function ccr_field(string $entity_type, string $bundle, string $name, string $type, array $storage = [], array $instance = []): void {
  if (!FieldStorageConfig::loadByName($entity_type, $name)) {
    FieldStorageConfig::create([
      'field_name' => $name,
      'entity_type' => $entity_type,
      'type' => $type,
      'cardinality' => $storage['cardinality'] ?? 1,
      'settings' => $storage['settings'] ?? [],
    ])->save();
  }
  if (!FieldConfig::loadByName($entity_type, $bundle, $name)) {
    FieldConfig::create([
      'field_name' => $name,
      'entity_type' => $entity_type,
      'bundle' => $bundle,
      'label' => $instance['label'] ?? $name,
      'description' => $instance['description'] ?? '',
      'required' => $instance['required'] ?? FALSE,
      'settings' => $instance['settings'] ?? [],
    ])->save();
    echo "  field {$entity_type}.{$bundle}.{$name}\n";
  }
}

// Storage is 255 — the ordinary string default — because how long a name may
// be is a question about a template, not about the business. The deck template
// currently in use gives it two lines at 12.89pt, which is roughly 36
// characters; that number is shown on the form as a counter and enforced by the
// renderer, which measures the real box rather than counting characters.
ccr_field('paragraph', 'capability_pillar', 'field_pillar_name', 'string',
  ['settings' => ['max_length' => 255]],
  [
    'label' => 'Name',
    'required' => TRUE,
    'description' => 'The pillar, named. The deck template you generate into decides how much of it fits.',
  ]
);

ccr_field('paragraph', 'capability_pillar', 'field_pillar_description', 'text_long', [],
  [
    'label' => 'Description',
    'required' => TRUE,
    'description' => 'One sentence. Use <strong>bold</strong> on the one word that matters — the deck renders it in Radiant green.',
  ]
);

// Icons are references, not uploads. A marketer picks a meaning; each channel
// resolves it to its own artwork. Nobody ever sources an image.
ccr_field('paragraph', 'capability_pillar', 'field_icon_token', 'list_string',
  ['settings' => ['allowed_values' => [
    'target' => 'Target — strategy, focus, outcomes',
    'product' => 'Product — interfaces, delivery, build',
    'cloud' => 'Cloud — infrastructure, platform, scale',
    'brain' => 'Intelligence — data, analytics, AI',
    'climb' => 'Climb — people, change, enablement',
  ]]],
  [
    'label' => 'Icon',
    'required' => TRUE,
    'description' => 'Pick the meaning. The deck and the website each draw their own icon for it.',
  ]
);

// ---------------------------------------------------------------------------
// 3. The Company Overview content type.
// ---------------------------------------------------------------------------
if (!NodeType::load('company_overview')) {
  NodeType::create([
    'type' => 'company_overview',
    'name' => 'Company overview',
    'description' => 'The single source of truth for what Radiant does. Drives the website and the capability deck.',
    'new_revision' => TRUE,
    'preview_mode' => DRUPAL_OPTIONAL,
    'display_submitted' => FALSE,
  ])->save();
  echo "created content type company_overview\n";
}

ccr_field('node', 'company_overview', 'field_positioning_statement', 'text_long', [],
  [
    'label' => 'Positioning statement',
    'required' => TRUE,
    'description' => 'What Radiant does, in one sentence. Bold the phrases that carry the argument.',
  ]
);

// Named for what it is, not for where it lands. It was `field_framework_label`
// until phase 2 — a label is what the slide calls it; a name is what it has.
ccr_field('node', 'company_overview', 'field_framework_name', 'string',
  ['settings' => ['max_length' => 255]],
  [
    'label' => 'Framework name',
    'required' => TRUE,
    'description' => 'The name of the approach. Named for what it is, not for the green band it lands on.',
  ]
);

ccr_field('node', 'company_overview', 'field_framework_statement', 'text_long', [],
  [
    'label' => 'Framework statement',
    'required' => TRUE,
    'description' => 'One line explaining the framework.',
  ]
);

// Unlimited. Five was the slide's limit, never the repository's: its row of
// icons and connecting arrows is fixed artwork that does not extend to six, and
// the website's "what we do" section has six. Storing five because one deck
// template holds five is the collateral problem in miniature — the channel
// deciding what the business is allowed to have. See docs/content-model.md §2.3.
ccr_field('node', 'company_overview', 'field_capability_pillars', 'entity_reference_revisions',
  ['cardinality' => FieldStorageConfig::CARDINALITY_UNLIMITED, 'settings' => ['target_type' => 'paragraph']],
  [
    'label' => 'Capability pillars',
    'required' => TRUE,
    'description' => 'As many as the business has. Each deck template says how many it can show; drag to reorder.',
    'settings' => [
      'handler' => 'default:paragraph',
      'handler_settings' => [
        'target_bundles' => ['capability_pillar' => 'capability_pillar'],
        'target_bundles_drag_drop' => ['capability_pillar' => ['enabled' => TRUE, 'weight' => 1]],
        'negate' => 0,
      ],
    ],
  ]
);

// The standard profile gives every content type a body field. This model has no
// place for free prose — that is the whole point of it — so it goes.
if ($body = FieldConfig::loadByName('node', 'company_overview', 'body')) {
  $body->delete();
  echo "removed the body field\n";
}

// Title is a base field, so its limit is a bundle override rather than storage.
$title_override = $entity_type_manager->getStorage('base_field_override')
  ->load('node.company_overview.title');
if (!$title_override) {
  $entity_type_manager->getStorage('base_field_override')->create([
    'field_name' => 'title',
    'entity_type' => 'node',
    'bundle' => 'company_overview',
    'label' => 'Title',
    'description' => 'What this overview is called.',
    'required' => TRUE,
  ])->save();
  echo "overrode the title field label\n";
}

// ---- case study (plan.md §8 A2) ---------------------------------------------
//
// The first record that holds *source material* rather than finished copy.
// Company overview is fielded because slide 4 and the website agreed on its
// shape. A case study does not: the slide wants points and four numbers, the
// web page wants paragraphs and a quote. So the record keeps what is true —
// the notes, the measured results, the interview — in one long text, and each
// channel's copy is written from it, approved by a person, and stored with the
// channel, never here. See plan.md §8 A2 for why that is H1 reworded, not
// abandoned.
if (!NodeType::load('case_study')) {
  NodeType::create([
    'type' => 'case_study',
    'name' => 'Case study',
    'description' => 'One piece of client work, as source material. The deck and the website each have their copy written from it.',
    'new_revision' => TRUE,
    'preview_mode' => DRUPAL_OPTIONAL,
    'display_submitted' => FALSE,
  ])->save();
  echo "created content type case_study\n";
}

ccr_field('node', 'case_study', 'field_client_name', 'string',
  ['settings' => ['max_length' => 255]],
  [
    'label' => 'Client',
    'required' => TRUE,
    'description' => 'The client, named exactly as they should be named in public.',
  ]
);

ccr_field('node', 'case_study', 'field_source_material', 'string_long', [],
  [
    'label' => 'Source material',
    'required' => TRUE,
    'description' => 'Everything true about the work: delivery notes, measured results and where each number came from, client interviews. '
      . 'Mark anything that must not be published as NOT FOR PUBLICATION. Channel copy is written from this, so a fact that is not here cannot appear on a slide or a page.',
  ]
);

if ($body = FieldConfig::loadByName('node', 'case_study', 'body')) {
  $body->delete();
  echo "removed the case study body field\n";
}

$display_repository = \Drupal::service('entity_display.repository');
$display_repository->getFormDisplay('node', 'case_study')
  ->setComponent('title', ['type' => 'string_textfield', 'weight' => 0])
  ->setComponent('field_client_name', ['type' => 'string_textfield', 'weight' => 1])
  ->setComponent('field_source_material', ['type' => 'string_textarea', 'weight' => 2, 'settings' => ['rows' => 24]])
  ->save();
$display_repository->getViewDisplay('node', 'case_study')
  ->setComponent('field_client_name', ['type' => 'string', 'label' => 'inline', 'weight' => 0])
  ->setComponent('field_source_material', ['type' => 'basic_string', 'label' => 'above', 'weight' => 1])
  ->removeComponent('links')
  ->save();

echo "\ncontent model built\n";
