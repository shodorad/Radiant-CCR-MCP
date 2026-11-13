<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\ccr_poc\RendererClient;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Datetime\DateFormatterInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * What a channel holds, and how it takes a fresh copy.
 *
 * The deck dashboard at /admin/content/decks already answers "which of my decks
 * have gone stale" — but it answers it as a themed Drupal page behind the
 * `generate ccr decks` permission, which a separate front end cannot read. This
 * is the same question with the answer in JSON and the audience being a channel
 * rather than a person sitting in the CMS.
 *
 * That is the point of it, and it is a small H2 claim in its own right: a third
 * channel attached here without the repository moving. It reads decks and asks
 * for a rebuild; it does not learn Drupal's field names, does not know what a
 * paragraph is, and cannot write to the record.
 *
 * **A channel takes its own copy of a deck.** `POST /ccr/deck/build` with a
 * `deck_id` the repository has never seen clones an existing definition into
 * it. From then on that id is the channel's — its own owner, its own generation
 * time, its own staleness — and rebuilding it replays the definition rather
 * than inventing one. Two channels can hold the same deck at different
 * versions, which is exactly the situation the collateral shelf is about.
 *
 * No auth and open CORS, like /ccr/record and /ccr/generation-log beside it.
 * Stated POC shortcut (plan.md §4) — production would authenticate service to
 * service, and this endpoint would be the first one to need it, because unlike
 * the other two it makes something.
 */
class ChannelController extends ControllerBase {

  public function __construct(
    protected RendererClient $renderer,
    protected DateFormatterInterface $dateFormatter,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('ccr_poc.renderer'),
      $container->get('date.formatter'),
    );
  }

  /**
   * Every deck this repository knows about, with what has moved under it.
   *
   * `?owner=` and `?channel=` narrow it, so a channel can ask for the decks it
   * handed out rather than filtering someone else's on the client.
   */
  public function decks(Request $request): JsonResponse {
    $owner = $request->query->get('owner');
    $channel = $request->query->get('channel');

    $decks = [];
    foreach (DeckGeneration::decks() as $deck_id => $deck) {
      $slides = $deck['slides'];
      $first = $slides[0];

      if ($owner !== NULL && $first->get('generated_by')->value !== $owner) {
        continue;
      }
      if ($channel !== NULL && $first->get('channel')->value !== $channel) {
        continue;
      }

      $decks[] = $this->describe($deck_id, $deck);
    }

    return new JsonResponse([
      'decks' => $decks,
      'stale' => count(array_filter($decks, fn($d) => $d['stale'])),
    ]);
  }

  /**
   * Build a deck for a channel and hand back the file.
   *
   * The generation is logged as part of producing it, not afterwards and not by
   * the caller: a download the repository does not know about is a deck that
   * can never be reported stale, which is the failure this whole feature is
   * about. So the file and the log row are written by the same request.
   */
  public function build(Request $request): Response {
    $payload = json_decode($request->getContent(), TRUE) ?: [];

    $deck_id = trim((string) ($payload['deck_id'] ?? ''));
    if ($deck_id === '') {
      return new JsonResponse(['error' => 'a build needs a deck_id: the name this channel keeps its copy under'], 400);
    }

    $definition = DeckGeneration::loadDeck($deck_id);
    $copied_from = NULL;

    // First time this channel asks for this deck: clone whichever definition it
    // named. Cloning rather than sharing is what lets the two copies drift
    // apart and be reported separately, which is the whole point.
    if (!$definition && !empty($payload['from'])) {
      $definition = DeckGeneration::loadDeck((string) $payload['from']);
      $copied_from = (string) $payload['from'];
    }

    if (!$definition) {
      $known = array_keys(DeckGeneration::decks());
      return new JsonResponse([
        'error' => sprintf(
          'no deck called "%s"%s. This repository holds: %s',
          $deck_id,
          $copied_from !== NULL ? sprintf(' and nothing to copy from called "%s"', $copied_from) : '',
          $known ? implode(', ', $known) : 'no decks at all'
        ),
      ], 404);
    }

    $label = (string) ($payload['label'] ?? $definition[0]->get('deck_label')->value ?: $deck_id);
    $owner = (string) ($payload['owner'] ?? 'channel');
    $channel = (string) ($payload['channel'] ?? 'pptx');

    $entries = [];
    foreach ($definition as $slide) {
      $node = $slide->getNode();
      if (!$node) {
        return new JsonResponse([
          'error' => sprintf('slide %d of this deck was made from content that no longer exists', (int) $slide->get('delta')->value + 1),
        ], 409);
      }
      try {
        $entries[] = \Drupal::service('ccr_poc.copy_store')
          ->deckEntry($node, $slide->get('template')->value, $slide->getSelection());
      }
      catch (\RuntimeException $e) {
        return new JsonResponse([
          'error' => sprintf('slide %d cannot be rebuilt: %s', (int) $slide->get('delta')->value + 1, $e->getMessage()),
        ], 409);
      }
    }

    try {
      $deck = $this->renderer->renderDeck($entries, $label);
    }
    catch (\RuntimeException $e) {
      // The renderer's refusals are written to be read by a person — a
      // selection naming a pillar the record no longer has says so by name. Passed
      // through rather than flattened to "500", because the channel is going to
      // show it to somebody who can act on it.
      return new JsonResponse(['error' => $e->getMessage()], 502);
    }

    DeckGeneration::saveDeck($deck_id, $label, $owner, $entries, $channel);

    return new Response($deck['body'], 200, [
      'Content-Type' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition' => 'attachment; filename="' . $deck['filename'] . '"',
      'Content-Length' => strlen($deck['body']),
      'X-CCR-Deck-Id' => $deck_id,
      'X-CCR-Slides' => (string) $deck['slides'],
      'X-CCR-Fit-Issues' => (string) $deck['issues'],
      'Cache-Control' => 'no-store',
    ]);
  }

  /**
   * One deck, as a channel needs to hear about it.
   *
   * Drift is reported twice on purpose: per slide, because that is where it can
   * be acted on, and once for the deck with the lines deduplicated, because the
   * positioning statement appearing on two slides is one edit and a channel
   * saying "2 lines changed" when one did would be wrong in the direction that
   * costs trust.
   */
  private function describe(string $deck_id, array $deck): array {
    $slides = [];
    $merged = [];
    $stale_slides = 0;
    $reportable = FALSE;

    foreach ($deck['slides'] as $slide) {
      $drift = $slide->drift();
      $can = $slide->canReportDrift();
      $reportable = $reportable || $can;

      // A row that can quote its lines is believed over the timestamp: it
      // cannot over-report a save that touched nothing this slide shows.
      $stale = $can ? $drift !== [] : $slide->isStale();
      $stale_slides += $stale ? 1 : 0;

      $n = (int) $slide->get('delta')->value + 1;
      foreach ($drift as $change) {
        $merged[$change['id']] ??= $change + ['slides' => []];
        $merged[$change['id']]['slides'][] = $n;
      }

      $node = $slide->getNode();
      $slides[] = [
        'n' => $n,
        'template' => $slide->get('template')->value ?: '(single slide)',
        'title' => $slide->get('content_title')->value,
        'nid' => (int) $slide->get('content_nid')->value,
        'items' => count($slide->getSelection()['items'] ?? []),
        'stale' => $stale,
        'can_report_drift' => $can,
        'changed_ago' => $node ? $this->dateFormatter->formatTimeDiffSince($node->getChangedTime()) : NULL,
        'drift' => $drift,
      ];
    }

    $first = $deck['slides'][0];
    $node = $first->getNode();

    return [
      'id' => $deck_id,
      'label' => $deck['label'],
      'owner' => $deck['owner'],
      'channel' => $first->get('channel')->value,
      'generated_at' => (int) $first->get('generated_at')->value,
      'generated_ago' => $this->dateFormatter->formatTimeDiffSince($deck['generated']),
      'slide_count' => count($slides),
      'stale' => $stale_slides > 0,
      'stale_slides' => $stale_slides,
      // False for decks logged before snapshots existed. A channel showing a
      // before/after needs to know it has nothing to quote, rather than reading
      // an empty change list as agreement.
      'can_report_drift' => $reportable,
      'changes' => array_values($merged),
      'record' => $node ? [
        'nid' => (int) $node->id(),
        'title' => $node->label(),
        'changed' => $node->getChangedTime(),
        'changed_ago' => $this->dateFormatter->formatTimeDiffSince($node->getChangedTime()),
      ] : NULL,
    ];
  }

}
