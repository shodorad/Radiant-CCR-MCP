<?php

namespace Drupal\ccr_poc;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Logger\LoggerChannelFactoryInterface;
use Drupal\node\NodeInterface;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Pushes a record to the website instance over JSON:API.
 *
 * The website is a second Drupal that consumes from this one. It has no
 * editorial workflow of its own — content only ever arrives here — which is the
 * whole demonstration behind H2: the repository is not the website, and the
 * website is just the first channel that happened to attach to it.
 *
 * Push-on-demand, on a button. Production would publish on an event, queued and
 * retried. Stated shortcut (plan.md §4), and the one that should be said out
 * loud to the maintaining developer rather than glossed over.
 */
class SitePublisher {

  public function __construct(
    protected ClientInterface $httpClient,
    protected ConfigFactoryInterface $configFactory,
    protected LoggerChannelFactoryInterface $loggerFactory,
  ) {}

  private function settings(): array {
    $config = $this->configFactory->get('ccr_poc.settings');
    return [
      'url' => rtrim($config->get('site_url') ?: 'http://ccr-site.ddev.site', '/'),
      'user' => $config->get('site_user') ?: 'admin',
      'pass' => $config->get('site_pass') ?: 'admin',
    ];
  }

  /**
   * Create or update the overview on the website instance.
   *
   * The node's UUID is the shared key. Using it rather than a node id means the
   * two instances stay matched up without either keeping a mapping table, and
   * a re-publish updates rather than duplicating.
   *
   * @return array{action: string, url: string}
   *
   * @throws \RuntimeException when the site is unreachable or rejects the push.
   */
  public function publish(NodeInterface $node): array {
    $site = $this->settings();
    $record = RecordNormaliser::toRecord($node);

    try {
      $response = $this->httpClient->request('POST', $site['url'] . '/ccr/receive', [
        'json' => $record,
        'auth' => [$site['user'], $site['pass']],
        'timeout' => 20,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException $e) {
      $this->loggerFactory->get('ccr_poc')->error('Publish to site failed: @m', ['@m' => $e->getMessage()]);
      throw new \RuntimeException(sprintf(
        'The website at %s did not answer. Is the site instance running?',
        $site['url']
      ), 0, $e);
    }

    $body = json_decode((string) $response->getBody(), TRUE) ?: [];
    if ($response->getStatusCode() >= 400) {
      throw new \RuntimeException(sprintf(
        'The website refused the update: %s',
        $body['error'] ?? $response->getReasonPhrase()
      ));
    }

    return [
      'action' => $body['action'] ?? 'updated',
      'url' => $body['url'] ?? $site['url'],
    ];
  }

  /**
   * What the website asks a record of this type to be written as.
   *
   * Asked, not configured: the page's fields and limits are the website's
   * business, and the repository learns them the way it learns what a slide
   * template holds — by asking the channel. NULL when the site does not answer
   * or has no contract for the type.
   */
  public function contract(string $type): ?array {
    try {
      $response = $this->httpClient->request('GET', $this->settings()['url'] . '/ccr/contract/' . rawurlencode($type), [
        'timeout' => 10,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return NULL;
    }
    $decoded = json_decode((string) $response->getBody(), TRUE);
    return $response->getStatusCode() === 200 && is_array($decoded) && isset($decoded['contract']) ? $decoded : NULL;
  }

  /**
   * Publish copy written for the website and approved here.
   *
   * The site receives the record's identity and that copy — not the source
   * material, which stays in the repository. The uuid is still the shared key.
   *
   * @return array{action: string, url: string}
   *
   * @throws \RuntimeException when the site is unreachable or refuses.
   */
  public function publishCopy(NodeInterface $node, array $copy): array {
    $site = $this->settings();
    $record = RecordNormaliser::toRecord($node);
    unset($record['source_material']);

    try {
      $response = $this->httpClient->request('POST', $site['url'] . '/ccr/receive', [
        'json' => $record + ['copy' => $copy],
        'auth' => [$site['user'], $site['pass']],
        'timeout' => 20,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException $e) {
      throw new \RuntimeException(sprintf('The website at %s did not answer. Is the site instance running?', $site['url']), 0, $e);
    }

    $body = json_decode((string) $response->getBody(), TRUE) ?: [];
    if ($response->getStatusCode() >= 400) {
      throw new \RuntimeException(sprintf('The website refused the page: %s', $body['error'] ?? $response->getReasonPhrase()));
    }
    return ['action' => $body['action'] ?? 'updated', 'url' => $body['url'] ?? $site['url']];
  }

}
