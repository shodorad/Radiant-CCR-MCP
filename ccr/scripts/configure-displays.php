<?php

/**
 * Shapes the editing form and the rendered output for Company Overview.
 *
 * Run with:  ddev drush php:script scripts/configure-displays.php
 *
 * H4 is decided here, not in the content model. A marketer will judge this
 * whole idea on whether the form is obvious, so the form does three things:
 * it shows every limit as a live counter rather than an error after saving, it
 * offers exactly one formatting control, and it never asks for a decision the
 * repository should be making — no text-format picker, no icon upload, no
 * "promoted to front page".
 *
 * **The counters changed in unwelding phase 2, twice over.**
 *
 * They no longer *enforce*. A counter that hard-stops typing at 36 characters
 * is not a hint, it is the slide's box reaching into the repository and telling
 * a marketer what the business is allowed to be called. The limit belongs to a
 * template; the renderer refuses at generation time, by name, with a way out.
 * What is left here is advice, and advice you can exceed.
 *
 * And the numbers are no longer written down here. They are read from the
 * default template's blueprint card, over the renderer's /health endpoint, so
 * there is one place they are *authored*. That is why this script now needs the
 * renderer running — a build step that depends on a service is a nuisance, and
 * it is a smaller one than a form advertising a limit the deck does not have.
 *
 * Be precise about what that buys, because it is easy to overclaim: running
 * this script *copies* the card's numbers into exported config, so the repo
 * still holds a second copy. What stops the two drifting is not the copying but
 * `tools/rehearse.js`, which reads the card and the live form and fails if they
 * disagree. Generated duplication is still duplication until something compares
 * the two ends.
 */

use Drupal\field\Entity\FieldConfig;

$display_repository = \Drupal::service('entity_display.repository');

/**
 * The default template's contract: slot path -> maxChars.
 *
 * Keyed by the slot's path in the card (`title`, `items.name`) rather than by
 * the record key it reads. Keying by the bare `source` flattened a repeating
 * slot's children into the same array as the top-level ones, so a future card
 * with both a top-level `name` and an `items.name` would have silently given
 * one of them the other's counter.
 *
 * The renderer's address comes from `ccr_poc.settings`, which is where
 * `RendererClient` already reads it. A second copy in this file was exactly the
 * duplication this phase was supposed to be removing.
 */
function ccr_limits(): array {
  $renderer = rtrim(\Drupal::config('ccr_poc.settings')->get('renderer_url') ?: '', '/');
  if (!$renderer) {
    throw new \RuntimeException('ccr_poc.settings has no renderer_url');
  }

  $json = @file_get_contents($renderer . '/health', FALSE, stream_context_create([
    'http' => ['timeout' => 5, 'ignore_errors' => TRUE],
  ]));
  $health = $json ? json_decode($json, TRUE) : NULL;
  if (!$health || empty($health['templates'])) {
    throw new \RuntimeException(sprintf(
      "cannot read the template contract from %s/health.\n" .
      "The form's character counters come from the default template's blueprint card,\n" .
      "so this script needs the renderer running:  ./demo.sh start",
      $renderer
    ));
  }

  $default = $health['default'] ?? NULL;
  $card = NULL;
  foreach ($health['templates'] as $candidate) {
    if (($candidate['id'] ?? NULL) === $default) {
      $card = $candidate;
    }
  }
  if (!$card) {
    throw new \RuntimeException(sprintf('the renderer has no template called "%s"', $default));
  }

  $limits = [];
  foreach ($card['contract'] as $name => $slot) {
    if (($slot['kind'] ?? '') === 'repeat') {
      foreach ($slot['slots'] as $child_name => $child) {
        if (($child['kind'] ?? '') === 'text') {
          $limits["{$name}.{$child_name}"] = $child['maxChars'];
        }
      }
      continue;
    }
    if (($slot['kind'] ?? '') === 'text') {
      $limits[$name] = $slot['maxChars'];
    }
  }

  echo "counter limits read from the \"{$card['id']}\" card: " . json_encode($limits) . "\n";
  return $limits;
}

$limits = ccr_limits();

/**
 * Live character counter — advice, not a wall.
 *
 * `maxlength_js_enforce` is FALSE deliberately: going over shows the marketer
 * that they have, and still lets them save. The template is what refuses, and
 * it does so where the marketer can choose a different template instead.
 */
function ccr_counter(int $limit): array {
  return [
    'maxlength' => [
      'maxlength_js' => $limit,
      'maxlength_js_label' => 'The <em>@limit</em>-character deck template fits about this much. <strong>@remaining</strong> left — you can go over.',
      'maxlength_js_enforce' => FALSE,
    ],
  ];
}

/** Lock a rich text field to the one format that exists. */
function ccr_lock_format(string $entity_type, string $bundle, string $field): void {
  $config = FieldConfig::loadByName($entity_type, $bundle, $field);
  if ($config && $config->getSetting('allowed_formats') !== ['ccr_inline']) {
    $config->setSetting('allowed_formats', ['ccr_inline']);
    $config->save();
    echo "  locked {$field} to the ccr_inline format\n";
  }
}

// ---------------------------------------------------------------------------
// Capability pillar — the paragraph form.
// ---------------------------------------------------------------------------
ccr_lock_format('paragraph', 'capability_pillar', 'field_pillar_description');

$pillar_form = $display_repository->getFormDisplay('paragraph', 'capability_pillar');
$pillar_form
  ->setComponent('field_pillar_name', [
    'type' => 'string_textfield',
    'weight' => 0,
    'settings' => ['size' => 40],
    'third_party_settings' => ccr_counter($limits['items.name']),
  ])
  ->setComponent('field_pillar_description', [
    'type' => 'text_textarea',
    'weight' => 1,
    'settings' => ['rows' => 2],
    'third_party_settings' => ccr_counter($limits['items.description']),
  ])
  ->setComponent('field_icon_token', [
    'type' => 'options_select',
    'weight' => 2,
  ])
  ->save();
echo "configured the capability pillar form\n";

$pillar_view = $display_repository->getViewDisplay('paragraph', 'capability_pillar');
$pillar_view
  ->setComponent('field_icon_token', ['type' => 'list_default', 'label' => 'hidden', 'weight' => 0])
  ->setComponent('field_pillar_name', ['type' => 'string', 'label' => 'hidden', 'weight' => 1])
  ->setComponent('field_pillar_description', ['type' => 'text_default', 'label' => 'hidden', 'weight' => 2])
  ->save();

// ---------------------------------------------------------------------------
// Company overview — the node form.
// ---------------------------------------------------------------------------
foreach (['field_positioning_statement', 'field_framework_statement'] as $field) {
  ccr_lock_format('node', 'company_overview', $field);
}

$form = $display_repository->getFormDisplay('node', 'company_overview');
$form
  ->setComponent('title', [
    'type' => 'string_textfield',
    'weight' => 0,
    'settings' => ['size' => 60],
    'third_party_settings' => ccr_counter($limits['title']),
  ])
  ->setComponent('field_positioning_statement', [
    'type' => 'text_textarea',
    'weight' => 1,
    'settings' => ['rows' => 3],
    'third_party_settings' => ccr_counter($limits['positioning']),
  ])
  ->setComponent('field_framework_name', [
    'type' => 'string_textfield',
    'weight' => 2,
    'settings' => ['size' => 60],
    'third_party_settings' => ccr_counter($limits['frameworkName']),
  ])
  ->setComponent('field_framework_statement', [
    'type' => 'text_textarea',
    'weight' => 3,
    'settings' => ['rows' => 2],
    'third_party_settings' => ccr_counter($limits['frameworkStatement']),
  ])
  ->setComponent('field_capability_pillars', [
    'type' => 'paragraphs',
    'weight' => 4,
    'settings' => [
      'title' => 'Capability pillar',
      'title_plural' => 'Capability pillars',
      'edit_mode' => 'open',
      'closed_mode' => 'summary',
      'add_mode' => 'button',
      'form_display_mode' => 'default',
      'default_paragraph_type' => 'capability_pillar',
      'features' => ['duplicate' => 'duplicate', 'collapse_edit_all' => 'collapse_edit_all'],
    ],
  ])
  ->save();

// Everything a marketer should not have to think about, taken off the form.
foreach (['promote', 'sticky', 'created', 'uid', 'path', 'url_redirects', 'comment'] as $extra) {
  $form->removeComponent($extra);
}
$form->save();
echo "configured the company overview form\n";

$view = $display_repository->getViewDisplay('node', 'company_overview');
$view
  ->setComponent('field_positioning_statement', ['type' => 'text_default', 'label' => 'hidden', 'weight' => 0])
  ->setComponent('field_framework_name', ['type' => 'string', 'label' => 'hidden', 'weight' => 1])
  ->setComponent('field_framework_statement', ['type' => 'text_default', 'label' => 'hidden', 'weight' => 2])
  ->setComponent('field_capability_pillars', [
    'type' => 'entity_reference_revisions_entity_view',
    'label' => 'hidden',
    'weight' => 3,
    'settings' => ['view_mode' => 'default'],
  ])
  ->save();
echo "configured the company overview display\n";

echo "\ndisplays configured\n";
