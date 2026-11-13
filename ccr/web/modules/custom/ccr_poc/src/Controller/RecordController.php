<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\RecordNormaliser;
use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Controller\ControllerBase;
use Drupal\node\NodeInterface;
use Symfony\Component\HttpFoundation\Request;

/**
 * The repository, publishing what it holds in a shape no channel had to guess.
 *
 * A channel used to read the CCR over JSON:API and flatten Drupal's field names
 * itself. That works, and it is what plan.md phase 3 built — but it puts the
 * repository's field structure inside every channel, which is the coupling H2
 * says should not exist, and it duplicates a translation the repository already
 * owns in RecordNormaliser. Renaming one field then meant editing the renderer
 * too, and forgetting to meant a field arriving silently empty on a slide.
 *
 * So the CCR answers the question directly. This is the same shape it POSTs to
 * the website's /ccr/receive and the same shape as fixtures/company-overview.json,
 * which is what lets the renderer be exercised with no Drupal running at all.
 *
 * JSON:API is untouched and remains the general-purpose read API.
 *
 * No auth, like the generation-log endpoint beside it: the renderer is trusted
 * on the local network. Stated POC shortcut (plan.md §4).
 */
class RecordController extends ControllerBase {

  public function read(Request $request): CacheableJsonResponse {
    $requested = $request->query->get('nid');

    // Every response varies by ?nid=. Without this context Drupal's dynamic
    // page cache keys on the path alone and replays one record for every value
    // of nid — which it did, silently, serving node 2 for ?nid=4242 on a HIT.
    // JSON:API, which this endpoint replaced, got this right; this is the price
    // of hand-rolling an endpoint and it has to be paid explicitly.
    $cache = (new CacheableMetadata())->addCacheContexts(['url.query_args:nid', 'url.query_args:view']);

    // ?view=public is the record as a chat channel may show it to a person:
    // NOT FOR PUBLICATION sections removed by the repository, not by the
    // channel. Without it the record is whole, which is what the renderer's
    // writer needs (it has to know what to leave out).
    $view = $request->query->get('view');
    if ($view !== NULL && $view !== 'public') {
      return $this->refuse(sprintf('"%s" is not a view; the only one is "public"', $view), $cache);
    }

    if ($requested !== NULL && !ctype_digit((string) $requested)) {
      return $this->refuse(sprintf('"%s" is not a node id', $requested), $cache);
    }

    $query = $this->entityTypeManager()->getStorage('node')->getQuery()
      // The renderer is a trusted service on the local network and has no
      // Drupal session, so this reads without an access check. `status = 1`
      // is what keeps unpublished content out. Stated shortcut, plan.md §4 —
      // and worth noticing that JSON:API does respect node access, so this
      // endpoint is the more permissive of the two by design, not by accident.
      ->accessCheck(FALSE)
      ->condition('status', NodeInterface::PUBLISHED)
      ->sort('nid')
      ->range(0, 1);

    if ($requested !== NULL) {
      // A named record may be any type the repository publishes.
      $query->condition('nid', (int) $requested)
        ->condition('type', RecordNormaliser::PUBLISHED_TYPES, 'IN');
    }
    else {
      // No nid keeps its original meaning — "the company overview" — because
      // the renderer's fromCCR() relies on it.
      $query->condition('type', 'company_overview');
      // No nid means "whichever one there is", so the answer changes when the
      // set of overviews changes, not merely when one of them is edited.
      $cache->addCacheTags(['node_list:company_overview']);
    }

    $ids = $query->execute();
    if (!$ids) {
      return $this->refuse(
        $requested !== NULL
          ? sprintf('no published record with nid %d', (int) $requested)
          : 'this repository has no published company overview',
        $cache->addCacheTags(['node_list:company_overview'])
      );
    }

    $node = $this->entityTypeManager()->getStorage('node')->load(reset($ids));
    $response = new CacheableJsonResponse(
      $view === 'public' ? RecordNormaliser::toPublicRecord($node) : RecordNormaliser::toRecord($node)
    );

    // The record is exactly as current as the node it came from. Saying so lets
    // Drupal invalidate it on edit rather than the renderer polling for change.
    $response->addCacheableDependency($cache);
    $response->addCacheableDependency(CacheableMetadata::createFromObject($node));
    return $response;
  }

  /**
   * What the repository holds: one line per published record, for a channel
   * that has to offer a choice before it reads anything whole.
   *
   * Summaries come from the public view, so a listing can never quote a
   * NOT FOR PUBLICATION line either. Same no-auth shortcut as read(); the
   * hosted deployment keeps /ccr/* off the public host.
   */
  public function list(Request $request): CacheableJsonResponse {
    $types = RecordNormaliser::PUBLISHED_TYPES;
    $cache = (new CacheableMetadata())->addCacheContexts(['url.query_args:type']);
    foreach ($types as $type) {
      $cache->addCacheTags(["node_list:{$type}"]);
    }

    $type = $request->query->get('type');
    if ($type !== NULL) {
      if (!in_array($type, $types, TRUE)) {
        return $this->refuse(sprintf('"%s" is not a type this repository publishes; it publishes %s', $type, implode(', ', $types)), $cache);
      }
      $types = [$type];
    }

    $storage = $this->entityTypeManager()->getStorage('node');
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('type', $types, 'IN')
      ->condition('status', NodeInterface::PUBLISHED)
      ->sort('title')
      ->execute();

    // The overview first, then case studies: PUBLISHED_TYPES order, then title.
    $nodes = $storage->loadMultiple($ids);
    $rank = array_flip(RecordNormaliser::PUBLISHED_TYPES);
    uasort($nodes, static fn ($a, $b) => $rank[$a->bundle()] <=> $rank[$b->bundle()] ?: strcasecmp($a->label(), $b->label()));

    $records = [];
    foreach ($nodes as $node) {
      $public = RecordNormaliser::toPublicRecord($node);
      $records[] = [
        'id' => $node->uuid(),
        'nid' => (int) $node->id(),
        'type' => $node->bundle(),
        'title' => $node->label(),
        'changed' => $node->getChangedTime(),
        'summary' => RecordNormaliser::summary($node),
        'fictional' => $public['fictional'],
      ];
      // An edit to any listed record changes its summary.
      $cache->addCacheableDependency($node);
    }

    $response = new CacheableJsonResponse(['records' => $records]);
    $response->addCacheableDependency($cache);
    return $response;
  }

  /**
   * A 404 that can be invalidated.
   *
   * A CacheableJsonResponse with no metadata is cached permanently with no tags,
   * so the first "there is nothing here" would outlive the content being
   * created. Carrying the tags means creating an overview clears it.
   */
  private function refuse(string $message, CacheableMetadata $cache): CacheableJsonResponse {
    $response = new CacheableJsonResponse(['error' => $message], 404);
    $response->addCacheableDependency($cache);
    return $response;
  }

}
