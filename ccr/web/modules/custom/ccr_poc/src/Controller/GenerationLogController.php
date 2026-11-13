<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\Core\Controller\ControllerBase;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * Lets the renderer report a generation it performed on its own.
 *
 * Decks made through the Drupal button are logged by DeckController. This
 * endpoint covers the other route — the renderer's CLI and its HTTP service —
 * so the repository's picture of what exists in the world does not depend on
 * which door the deck came out of.
 */
class GenerationLogController extends ControllerBase {

  public function record(Request $request): JsonResponse {
    $payload = json_decode($request->getContent(), TRUE) ?: [];

    $nid = $payload['content_nid'] ?? NULL;
    $uuid = $payload['content_id'] ?? NULL;

    $node = NULL;
    if ($nid) {
      $node = $this->entityTypeManager()->getStorage('node')->load($nid);
    }
    elseif ($uuid) {
      $matches = $this->entityTypeManager()->getStorage('node')->loadByProperties(['uuid' => $uuid]);
      $node = $matches ? reset($matches) : NULL;
    }

    if (!$node) {
      return new JsonResponse(['error' => 'no such content in this repository'], 404);
    }

    $entry = DeckGeneration::log(
      $node,
      (string) ($payload['generated_by'] ?? 'renderer'),
      (string) ($payload['channel'] ?? 'pptx'),
      // Optional, and absent from anything that logged before templates were
      // reported. Without it the row keeps the timestamp and says honestly that
      // it cannot name what changed.
      (string) ($payload['template'] ?? '')
    );
    return new JsonResponse([
      'id' => $entry->id(),
      'stale' => $entry->isStale(),
      'can_report_drift' => $entry->canReportDrift(),
    ]);
  }

}
