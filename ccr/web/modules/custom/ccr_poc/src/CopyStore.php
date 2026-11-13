<?php

namespace Drupal\ccr_poc;

use Drupal\Core\KeyValueStore\KeyValueFactoryInterface;
use Drupal\Core\KeyValueStore\KeyValueStoreInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\NodeInterface;

/**
 * The copy each channel has had written for a record — plan.md §8 A2.
 *
 * A case study's record holds source material. What a slide or the website
 * shows is written *from* it, per channel, and a person approves it. That copy
 * belongs to the channel it was written for, which is why it is kept here,
 * keyed by (record, channel), and **never on the node**: writing the slide's
 * sentences back into the record would make the record the slide's copy again,
 * and the next channel would be written from a summary of a summary.
 *
 * A channel is a written template id (`case-study-metrics`) or `website`.
 *
 * Kept in Drupal's key-value store rather than an entity: a small document per
 * (record, channel) that is read whole and replaced whole, with no listing,
 * querying or revisions anybody needs. The maintaining developer can read an
 * entry with `drush php:eval` and there is no schema to migrate.
 *
 * **Staleness is computed, not stored**, for the same reason DeckGeneration's
 * is: `source_changed` records which version of the record the approval was
 * for, and comparing it to the node's `changed` cannot drift.
 */
class CopyStore {

  public const WEBSITE = 'website';

  protected KeyValueStoreInterface $store;

  public function __construct(KeyValueFactoryInterface $factory) {
    $this->store = $factory->get('ccr_poc.copy');
  }

  private static function key(NodeInterface $node, string $channel): string {
    return $node->id() . ':' . $channel;
  }

  /**
   * @return array{copy: array, status: string, source_changed: int, fields: array, warnings: array,
   *   drafted_at?: int, drafted_by?: string, approved_at?: int, approved_by?: string,
   *   published_at?: int, published_changed?: int, url?: string}|null
   */
  public function get(NodeInterface $node, string $channel): ?array {
    return $this->store->get(self::key($node, $channel));
  }

  /**
   * Keep a draft — from the model or from a person's edit. Any edit un-approves:
   * what was approved is no longer what is here.
   */
  public function saveDraft(NodeInterface $node, string $channel, array $copy, array $fields, array $warnings, AccountInterface $by, bool $fromModel): array {
    $entry = ($this->get($node, $channel) ?? []);
    $entry = [
      'copy' => $copy,
      'status' => 'draft',
      'source_changed' => $fromModel ? $node->getChangedTime() : ($entry['source_changed'] ?? $node->getChangedTime()),
      'fields' => $fields,
      'warnings' => $warnings,
      'drafted_at' => \Drupal::time()->getRequestTime(),
      'drafted_by' => $by->getAccountName() ?: 'anonymous',
    ] + array_intersect_key($entry, array_flip(['published_at', 'published_changed', 'url']));
    $this->store->set(self::key($node, $channel), $entry);
    return $entry;
  }

  /**
   * Approve what is here, against the record as it is now. The caller has
   * already had the channel check it; this only records who said yes, when,
   * and to which version of the source.
   */
  public function approve(NodeInterface $node, string $channel, array $copy, array $fields, array $warnings, AccountInterface $by): array {
    $entry = $this->saveDraft($node, $channel, $copy, $fields, $warnings, $by, FALSE);
    $entry['status'] = 'approved';
    $entry['source_changed'] = $node->getChangedTime();
    $entry['approved_at'] = \Drupal::time()->getRequestTime();
    $entry['approved_by'] = $by->getAccountName() ?: 'anonymous';
    $this->store->set(self::key($node, $channel), $entry);
    return $entry;
  }

  /** The website now shows this copy. */
  public function markPublished(NodeInterface $node, string $url): void {
    $entry = $this->get($node, self::WEBSITE);
    if (!$entry) {
      return;
    }
    $entry['published_at'] = \Drupal::time()->getRequestTime();
    $entry['published_changed'] = $entry['source_changed'];
    $entry['url'] = $url;
    $this->store->set(self::key($node, self::WEBSITE), $entry);
  }

  /** Has the source moved since this copy was written or approved? */
  public static function isStale(?array $entry, NodeInterface $node): bool {
    return $entry !== NULL && $node->getChangedTime() > (int) ($entry['source_changed'] ?? 0);
  }

  /**
   * Where a channel stands, in one word the node page and the review page share.
   *
   * @return string none | draft | approved | out-of-date
   */
  public function state(NodeInterface $node, string $channel): string {
    $entry = $this->get($node, $channel);
    if (!$entry) {
      return 'none';
    }
    if (self::isStale($entry, $node)) {
      return 'out-of-date';
    }
    return $entry['status'];
  }

  /**
   * A deck entry for one slide, carrying its approved copy when the slide is
   * written. Every path that rebuilds a deck goes through here, so none of them
   * can quietly render a written slide from copy nobody approved, or from copy
   * approved against a source that has since changed.
   *
   * @return array ['template' => id, 'node' => node, 'selection' => array, 'record'?: array]
   *
   * @throws \RuntimeException naming what to do, when the copy is not usable.
   */
  public function deckEntry(NodeInterface $node, string $template, array $selection): array {
    $entry = ['template' => $template, 'node' => $node, 'selection' => $selection];
    $copy = $this->get($node, $template);
    if ($copy === NULL) {
      return $entry;
    }
    if (self::isStale($copy, $node)) {
      throw new \RuntimeException(sprintf(
        'the source material for "%s" changed after its slide copy was approved. Redraft and approve it at /node/%d/write/%s first.',
        $node->label(), $node->id(), $template
      ));
    }
    if ($copy['status'] !== 'approved') {
      throw new \RuntimeException(sprintf(
        'the slide copy for "%s" is a draft nobody has approved. Approve it at /node/%d/write/%s first.',
        $node->label(), $node->id(), $template
      ));
    }
    return $entry + ['record' => $copy['copy']];
  }

  /** Every channel with copy for this record — for the node page and its warnings. */
  public function channels(NodeInterface $node): array {
    $prefix = $node->id() . ':';
    $out = [];
    foreach ($this->store->getAll() as $key => $entry) {
      if (str_starts_with($key, $prefix)) {
        $out[substr($key, strlen($prefix))] = $entry;
      }
    }
    return $out;
  }

}
