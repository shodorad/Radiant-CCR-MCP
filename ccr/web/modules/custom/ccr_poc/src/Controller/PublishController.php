<?php

namespace Drupal\ccr_poc\Controller;

use Drupal\ccr_poc\SitePublisher;
use Drupal\Core\Controller\ControllerBase;
use Drupal\node\NodeInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\RedirectResponse;

/**
 * "Publish to site" — pushes the record to the website instance.
 */
class PublishController extends ControllerBase {

  public function __construct(protected SitePublisher $publisher) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('ccr_poc.site_publisher'));
  }

  public function publish(NodeInterface $node): RedirectResponse {
    try {
      $result = $this->publisher->publish($node);
      $this->messenger()->addStatus($this->t('Published to the website. The page was @action. <a href=":url" target="_blank">View it</a>.', [
        '@action' => $result['action'],
        ':url' => $result['url'],
      ]));
    }
    catch (\RuntimeException $e) {
      $this->messenger()->addError($this->t('Not published. @reason', ['@reason' => $e->getMessage()]));
    }
    return $this->redirect('entity.node.canonical', ['node' => $node->id()]);
  }

}
