<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\RecordNormaliser;
use Drupal\ccr_poc\RendererClient;
use Drupal\Core\Controller\ControllerBase;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * "Shorten to fit" — asks the deck channel for a shorter version of one line.
 *
 * A pass-through, deliberately. The edit form could call the renderer itself,
 * but then a marketer's browser would have to know a renderer exists and where
 * it lives; H4 is that they never learn either. It also puts the request behind
 * a permission and a CSRF token, which the renderer — trusted on the local
 * network and nothing more — does not have.
 *
 * Nothing is saved here and nothing is decided here. The suggestion goes back
 * to the form, where a person accepts it or does not, and saving the node is
 * still the only thing that changes the repository.
 */
class AssistController extends ControllerBase {

  /** Longer than anything a slide-bound field should be asked to shorten. */
  private const MAX_VALUE = 4000;

  public function __construct(protected RendererClient $renderer) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('ccr_poc.renderer'));
  }

  public function suggest(Request $request): JsonResponse {
    $asked = json_decode($request->getContent(), TRUE) ?: [];
    $source = (string) ($asked['source'] ?? '');
    $value = (string) ($asked['value'] ?? '');

    // Only lines this repository actually publishes. The renderer would refuse
    // anything else by name anyway; this keeps the route from being a general
    // way to put text in front of a language model.
    if (!in_array($source, RecordNormaliser::sources(), TRUE)) {
      return new JsonResponse(['ok' => FALSE, 'reason' => 'That is not a line this record publishes.'], 400);
    }
    if (mb_strlen($value) > self::MAX_VALUE) {
      return new JsonResponse(['ok' => FALSE, 'reason' => 'That is too long to shorten a line at a time. Cut it down by hand first.'], 400);
    }

    return new JsonResponse($this->renderer->suggest($source, $value, mb_substr((string) ($asked['about'] ?? ''), 0, 200)));
  }

}
