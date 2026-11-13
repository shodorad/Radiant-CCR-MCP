<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\ccr_poc\RendererClient;
use Drupal\Core\Controller\ControllerBase;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * Rebuild a deck somebody already defined.
 *
 * Choosing what a deck contains is DeckBuilderForm's job. This is the other
 * half, and it is what makes the staleness flag mean something: a deck that has
 * gone out of date can be made current again without anyone having to remember
 * which five pillars they picked last time. The definition is stored, so the
 * deck is rebuilt as the thing somebody decided rather than as whatever the
 * defaults would produce today.
 *
 * A selection naming an item the record no longer holds is refused by the
 * renderer, by name — see renderer/lib/select.js. That refusal is the point:
 * silently rebuilding a deck as something else is exactly the drift the CCR
 * exists to end.
 */
class DeckController extends ControllerBase {

  public function __construct(protected RendererClient $renderer) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('ccr_poc.renderer'));
  }

  public function regenerate(string $deck_id): Response {
    $slides = DeckGeneration::loadDeck($deck_id);
    if (!$slides) {
      $this->messenger()->addError($this->t('There is no deck called "@id" any more.', ['@id' => $deck_id]));
      return $this->redirect('ccr_poc.dashboard');
    }

    $entries = [];
    $label = $deck_id;
    foreach ($slides as $slide) {
      $node = $slide->getNode();
      if (!$node) {
        $this->messenger()->addError($this->t('Slide @n of this deck was made from content that no longer exists.', [
          '@n' => (int) $slide->get('delta')->value + 1,
        ]));
        return $this->redirect('ccr_poc.dashboard');
      }
      $label = $slide->get('deck_label')->value ?: $label;
      try {
        $entries[] = \Drupal::service('ccr_poc.copy_store')
          ->deckEntry($node, $slide->get('template')->value, $slide->getSelection());
      }
      catch (\RuntimeException $e) {
        $this->messenger()->addError($this->t('Slide @n cannot be rebuilt: @reason', [
          '@n' => (int) $slide->get('delta')->value + 1,
          '@reason' => $e->getMessage(),
        ]));
        return $this->redirect('ccr_poc.dashboard');
      }
    }

    try {
      $deck = $this->renderer->renderDeck($entries, $label);
    }
    catch (\RuntimeException $e) {
      $this->messenger()->addError($this->t('The deck could not be regenerated. @reason', ['@reason' => $e->getMessage()]));
      return $this->redirect('ccr_poc.dashboard');
    }

    DeckGeneration::saveDeck(
      $deck_id,
      $label,
      $slides[0]->get('generated_by')->value ?: 'anonymous',
      $entries
    );

    return new Response($deck['body'], 200, [
      'Content-Type' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition' => 'attachment; filename="' . $deck['filename'] . '"',
      'Content-Length' => strlen($deck['body']),
      'Cache-Control' => 'no-store',
    ]);
  }

}
