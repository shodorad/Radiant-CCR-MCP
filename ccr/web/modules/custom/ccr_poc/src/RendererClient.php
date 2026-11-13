<?php

namespace Drupal\ccr_poc;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\node\NodeInterface;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Talks to the deck renderer.
 *
 * The repository does not know how a slide is built, only that something out
 * there will build one if handed a record. That is the shape H2 is testing: a
 * channel attaches to the repository and can be replaced without the repository
 * changing. The renderer could be swapped for a PDF service tomorrow and
 * nothing in this class's callers would move.
 */
class RendererClient {

  public function __construct(
    protected ClientInterface $httpClient,
    protected ConfigFactoryInterface $configFactory,
  ) {}

  public function endpoint(): string {
    return rtrim($this->configFactory->get('ccr_poc.settings')->get('renderer_url') ?: 'http://host.docker.internal:5001', '/');
  }

  /**
   * Render a node to a .pptx.
   *
   * The record is posted rather than the renderer being told to go and fetch
   * it, so that what is rendered is exactly what the editor is looking at.
   *
   * @return array{body: string, filename: string, issues: array}
   *
   * @throws \RuntimeException when the renderer is unreachable or refuses.
   */
  public function render(NodeInterface $node): array {
    $record = RecordNormaliser::toRecord($node);

    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . '/render', [
        'json' => $record,
        'timeout' => 30,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException $e) {
      throw new \RuntimeException(sprintf(
        'The deck renderer at %s did not answer: %s',
        $this->endpoint(),
        $e->getMessage()
      ), 0, $e);
    }

    $body = (string) $response->getBody();
    if ($response->getStatusCode() !== 200) {
      $detail = json_decode($body, TRUE)['error'] ?? $body;
      throw new \RuntimeException(sprintf('The renderer refused this record: %s', $detail));
    }

    return [
      'body' => $body,
      'filename' => $this->filenameFrom($response->getHeaderLine('Content-Disposition'), $node),
      'issues' => (int) ($response->getHeaderLine('X-CCR-Fit-Issues') ?: 0),
    ];
  }

  /**
   * Which templates can show this record, and why the others cannot.
   *
   * The repository does not know what a template is, what it holds or why it
   * refuses — it asks the channel and shows the answer. That is the same shape
   * as everything else here: the CCR owns the content and the deck definition,
   * the renderer owns what can be made of them.
   *
   * @return array a list of {id, name, status, holds, refusals, warnings}
   */
  public function match(NodeInterface $node): array {
    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . '/match', [
        'json' => RecordNormaliser::toRecord($node),
        'timeout' => 10,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return [];
    }
    return json_decode((string) $response->getBody(), TRUE)['templates'] ?? [];
  }

  /**
   * Render a deck definition: an ordered list of (template, record, selection).
   *
   * The definition is posted whole rather than a slide at a time, because a
   * deck is one file and the renderer is the only thing that knows how to make
   * several filled slides into one package without their parts colliding.
   *
   * @param array $entries
   *   Each: ['template' => id, 'node' => NodeInterface, 'selection' => array].
   *
   * @return array{body: string, filename: string, issues: int, slides: int}
   *
   * @throws \RuntimeException when the renderer is unreachable or refuses.
   */
  public function renderDeck(array $entries, string $title): array {
    $payload = ['title' => $title, 'entries' => []];
    foreach ($entries as $entry) {
      $payload['entries'][] = [
        'template' => $entry['template'],
        'selection' => (object) ($entry['selection'] ?? []),
        // A written slide renders its approved copy, not the record — see
        // CopyStore::deckEntry(), which is the only thing that sets this.
        'record' => $entry['record'] ?? RecordNormaliser::toRecord($entry['node']),
      ];
    }

    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . '/deck', [
        'json' => $payload,
        'timeout' => 60,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException $e) {
      throw new \RuntimeException(sprintf(
        'The deck renderer at %s did not answer: %s',
        $this->endpoint(),
        $e->getMessage()
      ), 0, $e);
    }

    $body = (string) $response->getBody();
    if ($response->getStatusCode() !== 200) {
      $detail = json_decode($body, TRUE)['error'] ?? $body;
      throw new \RuntimeException(sprintf('The renderer refused this deck: %s', $detail));
    }

    return [
      'body' => $body,
      'filename' => $this->filenameFrom($response->getHeaderLine('Content-Disposition'), $entries[0]['node']),
      'issues' => (int) ($response->getHeaderLine('X-CCR-Fit-Issues') ?: 0),
      'slides' => (int) ($response->getHeaderLine('X-CCR-Slides') ?: 0),
    ];
  }

  /**
   * The lines this template puts on a slide, for this record and selection.
   *
   * Stored beside a generation so the repository can say later which lines
   * moved. The renderer is asked rather than the answer being worked out here,
   * because which fields reach a slide is a fact about the artwork — see
   * renderer/lib/values.js.
   *
   * Returns an empty array when the renderer is unreachable or refuses. A
   * missing snapshot is handled everywhere as "cannot tell", which falls back
   * to the timestamp; inventing an empty line list would read as "nothing
   * changed" and be wrong in the one direction that matters.
   *
   * @return array{template?: string, title?: string, lines?: array}
   */
  public function values(NodeInterface $node, string $template, array $selection = [], ?array $record = NULL): array {
    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . '/values', [
        'query' => ['template' => $template],
        'json' => [
          'record' => $record ?? RecordNormaliser::toRecord($node),
          'selection' => (object) $selection,
        ],
        'timeout' => 10,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return [];
    }
    if ($response->getStatusCode() !== 200) {
      return [];
    }
    $decoded = json_decode((string) $response->getBody(), TRUE);
    return is_array($decoded) && isset($decoded['lines']) ? $decoded : [];
  }

  /** Ask the renderer whether this record fits, without producing a file. */
  public function preflight(NodeInterface $node): array {
    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . '/preflight', [
        'json' => RecordNormaliser::toRecord($node),
        'timeout' => 10,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return [];
    }
    return json_decode((string) $response->getBody(), TRUE)['issues'] ?? [];
  }

  /**
   * Can the deck channel offer to rewrite a line that does not fit its artwork?
   *
   * Asked rather than configured here. Whether there is a language model behind
   * the renderer, which one, and whose key pays for it are the channel's
   * business; the repository holds no key and no model name. A renderer that is
   * down, slow or has no assistant all come back as "no", and the edit form
   * simply offers nobody a button — a form that waits on an optional extra is
   * worse than a form without it, hence the short timeout.
   */
  public function assistantAvailable(): bool {
    try {
      $response = $this->httpClient->request('GET', $this->endpoint() . '/health', [
        'timeout' => 2,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return FALSE;
    }
    return (bool) (json_decode((string) $response->getBody(), TRUE)['ai']['available'] ?? FALSE);
  }

  /**
   * Ask the deck channel for a shorter version of one line.
   *
   * The line is named by its record key and sent as the editor has it now,
   * unsaved. What comes back has already been measured against the template's
   * box by the renderer — this class, like the rest of the repository, never
   * learns what the box is.
   *
   * @return array{ok: bool, reason?: string, suggestion?: string, before?: array, after?: array, limit?: array}
   *   Always something an editor can be shown; never throws.
   */
  public function suggest(string $source, string $value, string $about = ''): array {
    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . '/suggest', [
        'json' => array_filter(['source' => $source, 'value' => $value, 'about' => $about]),
        // The renderer may ask its model up to three times before answering.
        'timeout' => 100,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return ['ok' => FALSE, 'reason' => 'The deck renderer did not answer, so it could not be asked for a shorter version.'];
    }

    $decoded = json_decode((string) $response->getBody(), TRUE);
    if ($response->getStatusCode() !== 200 || !is_array($decoded)) {
      return ['ok' => FALSE, 'reason' => 'The deck renderer could not suggest a shorter version: ' . ($decoded['error'] ?? 'no reason given')];
    }
    return $decoded;
  }

  /**
   * The templates the deck channel holds, with their contracts — including
   * which are *written* (filled from approved copy) and which kind of record
   * each draws on. Empty when the renderer is not answering.
   */
  public function templates(): array {
    try {
      $response = $this->httpClient->request('GET', $this->endpoint() . '/health', ['timeout' => 5, 'http_errors' => FALSE]);
    }
    catch (GuzzleException) {
      return [];
    }
    return json_decode((string) $response->getBody(), TRUE)['templates'] ?? [];
  }

  /** The written templates for one kind of record, by id. */
  public function writtenTemplates(string $bundle): array {
    $out = [];
    foreach ($this->templates() as $template) {
      if (!empty($template['written']) && ($template['record'] ?? NULL) === $bundle) {
        $out[$template['id']] = $template;
      }
    }
    return $out;
  }

  /**
   * Ask the writer to draft every field of a channel from this record's
   * source material. `$channel` is ['template' => id] for a slide, or
   * ['contract' => array] for a channel that brought its own (the website).
   *
   * The repository sends the record and shows what comes back; what the
   * fields are, how they are measured and which passed are the writer's
   * answers, not this module's.
   *
   * @return array{ok: bool, copy: array, fields: array, warnings: array, reason?: string}
   *   Never throws — an unreachable renderer is an answer an editor can read.
   */
  public function draft(NodeInterface $node, array $channel): array {
    return $this->writerCall('/draft', $channel + ['record' => RecordNormaliser::toRecord($node)], 400)
      + ['ok' => FALSE, 'copy' => [], 'fields' => [], 'warnings' => []];
  }

  /**
   * Measure copy a person has edited, against the channel it is for. No model
   * is involved; this is the check between an edit and "Approve".
   *
   * @return array{ok: bool, fields: array, warnings: array, reason?: string}
   */
  public function checkCopy(NodeInterface $node, array $channel, array $copy): array {
    return $this->writerCall('/copy/check', $channel + ['record' => RecordNormaliser::toRecord($node), 'copy' => (object) $copy], 20)
      + ['ok' => FALSE, 'fields' => [], 'warnings' => []];
  }

  private function writerCall(string $path, array $payload, int $timeout): array {
    try {
      $response = $this->httpClient->request('POST', $this->endpoint() . $path, [
        'json' => $payload,
        'timeout' => $timeout,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException) {
      return ['reason' => 'The deck renderer did not answer, so nothing could be written or checked. Start it with ./demo.sh start.'];
    }
    $decoded = json_decode((string) $response->getBody(), TRUE);
    if ($response->getStatusCode() !== 200 || !is_array($decoded)) {
      return ['reason' => 'The renderer refused: ' . ($decoded['error'] ?? 'no reason given')];
    }
    return $decoded;
  }

  private function filenameFrom(string $disposition, NodeInterface $node): string {
    if (preg_match('/filename="([^"]+)"/', $disposition, $m)) {
      return $m[1];
    }
    return preg_replace('/[^a-z0-9]+/', '-', strtolower($node->label())) . '.pptx';
  }

}
