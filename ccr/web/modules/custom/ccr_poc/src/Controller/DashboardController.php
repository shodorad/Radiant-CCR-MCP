<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Datetime\DateFormatterInterface;
use Drupal\Core\Url;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;

/**
 * "My decks" — the notification feed.
 *
 * Delivery is a flag on a page, not an email. That is a stated shortcut
 * (plan.md §4), and the honest reason is that a laptop has no reliable outbound
 * mail; the concept being tested is whether the repository can *know* a deck
 * has gone stale, not whether it can send a message.
 *
 * The page polls its own feed rather than waiting for a reload, because the
 * demo turns on the notification appearing while the CEO is looking at it. The
 * polling is real: it re-reads the same computed staleness the page rendered.
 */
class DashboardController extends ControllerBase {

  public function __construct(protected DateFormatterInterface $dateFormatter) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('date.formatter'));
  }

  /**
   * One row per deck someone is holding, newest first.
   *
   * A deck is several slides now, so a row summarises them and names the ones
   * that have drifted. "2 of 3 slides are out of date" is a sentence somebody
   * can act on; "this deck is out of date" was true before and is still true
   * when only the cover has changed.
   */
  private function rows(): array {
    $rows = [];
    foreach (DeckGeneration::decks() as $deck_id => $deck) {
      $slides = [];
      foreach ($deck['slides'] as $slide) {
        $node = $slide->getNode();
        $slides[] = [
          'n' => (int) $slide->get('delta')->value + 1,
          'template' => $slide->get('template')->value ?: '(single slide)',
          'title' => $slide->get('content_title')->value,
          'items' => count($slide->getSelection()['items'] ?? []),
          'stale' => $slide->isStale(),
          'changed_ago' => $node ? $this->dateFormatter->formatTimeDiffSince($node->getChangedTime()) : NULL,
        ];
      }

      $rows[] = [
        'id' => $deck_id,
        'title' => $deck['label'],
        'owner' => $deck['owner'],
        'ago' => $this->dateFormatter->formatTimeDiffSince($deck['generated']),
        'stale' => $deck['stale'] > 0,
        'stale_count' => $deck['stale'],
        'slide_count' => count($slides),
        'slides' => $slides,
        'changed_ago' => $slides[0]['changed_ago'] ?? NULL,
        'regenerate' => Url::fromRoute('ccr_poc.regenerate_deck', ['deck_id' => $deck_id])->toString(),
      ];
    }
    return $rows;
  }

  public function page(): array {
    return [
      '#theme' => 'ccr_deck_dashboard',
      '#rows' => $this->rows(),
      '#attached' => [
        'library' => ['ccr_poc/dashboard'],
        'drupalSettings' => [
          'ccrPoc' => [
            'feedUrl' => Url::fromRoute('ccr_poc.dashboard_feed')->toString(),
            'pollSeconds' => 4,
          ],
        ],
      ],
      '#cache' => ['max-age' => 0],
    ];
  }

  public function feed(): JsonResponse {
    $rows = $this->rows();
    return new JsonResponse([
      'rows' => $rows,
      'stale' => count(array_filter($rows, fn($r) => $r['stale'])),
    ]);
  }

}
