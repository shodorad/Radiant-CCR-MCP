<?php

namespace Drupal\ccr_poc;

use Drupal\node\NodeInterface;

/**
 * Flattens a Company Overview node into the channel-neutral record shape.
 *
 * Both channels — the deck renderer and the website instance — consume this
 * shape rather than Drupal's field structure. Keeping the translation in one
 * place is what lets the repository's internals change without every channel
 * having to learn about it, and it is the same shape as the phase 0 fixture so
 * the renderer can be exercised with no Drupal running at all.
 *
 * The field-name mapping is documented in docs/content-model.md §5.
 */
class RecordNormaliser {

  /**
   * Drupal field => the record's name for it: the text on the node itself.
   *
   * A constant rather than lines inside toRecord() because the pairs now have
   * a second reader. The writing assistant on the edit form has to tell a
   * channel *which* line it is asking about, and it must say so in the record's
   * words — the form knows Drupal's field names and a channel must never have
   * to. Two lists of the same pairs would drift; this is the one list.
   */
  public const NODE_TEXT = [
    'field_positioning_statement' => 'positioning_statement',
    'field_framework_name' => 'framework_name',
    'field_framework_statement' => 'framework_statement',
  ];

  /** The same, for the text on each capability pillar. */
  public const PILLAR_TEXT = [
    'field_pillar_name' => 'name',
    'field_pillar_description' => 'description',
  ];

  /**
   * The bundles this repository publishes to channels, in listing order.
   *
   * One list, read by both /ccr/records and /ccr/record, so a bundle cannot be
   * listed without being readable or the other way round.
   */
  public const PUBLISHED_TYPES = ['company_overview', 'case_study'];

  /**
   * A heading in case-study source material: a line that opens in capitals,
   * optionally followed by "(…)" or "— …". "MEASURED RESULTS (from …)",
   * "CLIENT INTERVIEW — Dana Okafor, …", "NOT FOR PUBLICATION".
   */
  private const HEADING = '/^[A-Z][A-Z0-9 \'&\/-]{2,}(\s*[(—–].*)?$/u';

  /** Headings whose section never leaves the repository through a public view. */
  private const WITHHELD = '/^NOT FOR PUBLICATION\b/u';

  /**
   * The record as a channel that puts words in front of people may see it.
   *
   * Case-study source material carries a NOT FOR PUBLICATION section by design
   * — contract values, incidents, logo permissions — because the writer has to
   * know what to leave out. A chat channel hands text straight to a person, so
   * for it the repository removes those sections itself rather than trusting
   * every channel to remember. `withheld` names what was removed, so a channel
   * can say that something was, without seeing what.
   */
  public static function toPublicRecord(NodeInterface $node): array {
    $record = self::toRecord($node);
    if ($record['type'] === 'case_study') {
      [$record['source_material'], $record['withheld']] = self::withoutUnpublishable((string) $record['source_material']);
    }
    $record['fictional'] = self::isFictional($record);
    return $record;
  }

  /**
   * One line a person can choose from in a listing, never more than ~200 chars.
   */
  public static function summary(NodeInterface $node): string {
    $record = self::toRecord($node);
    if ($record['type'] === 'company_overview') {
      return self::clip(strip_tags((string) $record['positioning_statement']));
    }

    [$material] = self::withoutUnpublishable((string) $record['source_material']);
    foreach (preg_split('/\R\s*\R/u', $material) as $paragraph) {
      $paragraph = trim($paragraph);
      $first = strtok($paragraph, "\n");
      // The opening prose paragraph: not the FICTIONAL/PLACEHOLDER disclaimer,
      // not a heading, not a bullet list.
      if ($paragraph === '' || preg_match(self::HEADING, $first) || str_starts_with($paragraph, '-')) {
        continue;
      }
      $sentence = preg_split('/(?<=[.!?])\s+/u', $paragraph, 2)[0];
      $client = (string) ($record['client_name'] ?? '');
      // Name the client once: most source material opens with their name.
      return self::clip($client === '' || str_starts_with($sentence, $client) ? $sentence : "{$client}: {$sentence}");
    }
    return self::clip((string) ($record['client_name'] ?? $record['title']));
  }

  /**
   * Remove every NOT FOR PUBLICATION section: its heading and all that follows
   * up to the next heading or the end.
   *
   * @return array{0: string, 1: string[]}
   *   The material without them, and the headings removed.
   */
  public static function withoutUnpublishable(string $material): array {
    $kept = [];
    $withheld = [];
    $skipping = FALSE;
    foreach (preg_split('/\R/u', $material) as $line) {
      $trimmed = trim($line);
      if ($trimmed !== '' && preg_match(self::HEADING, $trimmed)) {
        $skipping = (bool) preg_match(self::WITHHELD, $trimmed);
        if ($skipping) {
          $withheld[] = $trimmed;
          continue;
        }
      }
      if (!$skipping) {
        $kept[] = $line;
      }
    }
    return [rtrim(implode("\n", $kept)), $withheld];
  }

  /** Content written for the POC that must not be mistaken for a real claim. */
  private static function isFictional(array $record): bool {
    $text = ltrim((string) ($record['source_material'] ?? '')) . ' ' . $record['title'];
    return (bool) preg_match('/^(FICTIONAL|PLACEHOLDER)\b|\bPLACEHOLDER\b/u', $text);
  }

  private static function clip(string $text, int $max = 200): string {
    $text = trim(preg_replace('/\s+/u', ' ', $text));
    return mb_strlen($text) <= $max ? $text : rtrim(mb_substr($text, 0, $max - 1)) . '…';
  }

  /**
   * Every text field on the edit form, by the record key a channel knows it as.
   *
   * @return array<string, string>
   *   e.g. 'field_pillar_description' => 'capability_pillars.description'.
   */
  public static function sources(): array {
    $sources = ['title' => 'title'] + self::NODE_TEXT;
    foreach (self::PILLAR_TEXT as $field => $key) {
      $sources[$field] = 'capability_pillars.' . $key;
    }
    return $sources;
  }

  public static function toRecord(NodeInterface $node): array {
    if ($node->bundle() === 'case_study') {
      return self::caseStudy($node);
    }

    $pillars = [];
    $weight = 1;
    foreach ($node->get('field_capability_pillars')->referencedEntities() as $pillar) {
      $text = [];
      foreach (self::PILLAR_TEXT as $field => $key) {
        $text[$key] = $pillar->get($field)->value;
      }
      $pillars[] = [
        // How a deck names this item. A channel that shows five of six has to
        // record *which* five, and a position would silently follow the wrong
        // ones the moment somebody drags a pillar. The paragraph's uuid is
        // stable across edits of its content and changes only when the item is
        // genuinely a different item — which is exactly when a deck selecting
        // it should be made to say so rather than quietly rebuild itself.
        'key' => $pillar->uuid(),
        'weight' => $weight++,
      ] + $text + [
        'icon_token' => $pillar->get('field_icon_token')->value,
      ];
    }

    $text = [];
    foreach (self::NODE_TEXT as $field => $key) {
      $text[$key] = $node->get($field)->value;
    }

    return [
      'id' => $node->uuid(),
      'nid' => (int) $node->id(),
      'type' => 'company_overview',
      'changed' => $node->getChangedTime(),
      'title' => $node->label(),
    ] + $text + [
      'capability_pillars' => $pillars,
    ];
  }

  /**
   * A case study is source material, not copy: the record is its identity and
   * what is true about the work. No channel renders this directly — each has
   * its copy written from it (plan.md §8 A2).
   */
  private static function caseStudy(NodeInterface $node): array {
    return [
      'id' => $node->uuid(),
      'nid' => (int) $node->id(),
      'type' => 'case_study',
      'changed' => $node->getChangedTime(),
      'title' => $node->label(),
      'client_name' => $node->get('field_client_name')->value,
      'source_material' => $node->get('field_source_material')->value,
    ];
  }

}
